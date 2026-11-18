-- b-auth-invariants-0391.sql - Audit B (login and accounts, 18 Nov 2026): the database's access-control invariants in ONE
-- suite, checked against the whole migrated database (every table / policy / function, not a sample), so a later
-- migration that forgets a revoke, adds a loose policy or a new signed-out RPC fails here before it reaches a studio:
--   * row-level security is ON for every table in public;
--   * no permissive write policy is a bare "true" (public + storage), no signed-out "true" read, and the only signed-in
--     "true" read is the global stage-move list (quote_stage_moves: no studio data);
--   * every permissive policy on a studio table (one with org_id) is scoped (current_org_id / auth.uid / HQ helpers);
--   * the signed-out role (anon) holds no privilege on any table or view;
--   * no "dead" signed-in table privilege: a privilege the policies never use (0391 removed the last ones);
--   * secret / bookkeeping tables (OTP + PIN hashes, link tokens, lockout counters, HQ sessions, ...) have no
--     signed-in privilege at all, and keep hashes only (no plaintext code / pin / password column);
--   * every SECURITY DEFINER function pins its search_path; signed-out callers reach none with a non-empty one
--     except the two crew-link readers kept from phase 1 (worker_get_tasks / worker_get_equipment);
--   * the functions a signed-out caller can run are exactly the known public / token endpoints (the allow-list below):
--     a NEW anon-executable function fails this suite until it is added here on purpose;
--   * the Supabase Auth hooks run for supabase_auth_admin only;
--   * views run with the caller's rights (security_invoker);
--   * behaviour: another studio's admin sees none of studio A's rows; a bare sign-up (no studio) has no area, no admin,
--     sees no quote / studio; a studio admin can't raise their own plan / seats / trial, role or studio.
-- 0391 is re-applied twice first (idempotent). Read-only otherwise; rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
\ir ../../supabase/migrations/0391_b_auth_dead_grants.sql
\ir ../../supabase/migrations/0391_b_auth_dead_grants.sql
set client_min_messages = warning;
begin;
create temp table _b391(name text, result text);
grant all on _b391 to anon, authenticated;
create function pg_temp.res(p_name text, p_ok boolean, p_detail text default null) returns void language sql as $$
  insert into _b391 values (p_name, case when p_ok then 'PASS' else 'FAIL ' || coalesce(p_detail, '') end);
$$;

-- ---- 01 RLS on every table ---------------------------------------------------------------------------------------
select pg_temp.res('01 row-level security is on for every table in public',
  count(*) = 0, string_agg(c.relname, ', '))
  from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and not c.relrowsecurity;

-- ---- 02-05 policies ------------------------------------------------------------------------------------------------
select pg_temp.res('02 no permissive write policy is a bare true (public + storage)', count(*) = 0,
  string_agg(p.schemaname || '.' || p.tablename || ':' || p.policyname, ', '))
  from pg_policies p
 where p.schemaname in ('public', 'storage') and p.permissive = 'PERMISSIVE'
   and p.roles && array['anon', 'authenticated', 'public']::name[]
   and (   (p.cmd = 'INSERT' and coalesce(p.with_check, 'true') = 'true')
        or (p.cmd in ('UPDATE', 'DELETE', 'ALL') and coalesce(p.qual, 'true') = 'true')
        or (p.cmd in ('UPDATE', 'ALL') and coalesce(p.with_check, p.qual, 'true') = 'true'));

select pg_temp.res('03 no permissive signed-out read is a bare true (public)', count(*) = 0,
  string_agg(p.tablename || ':' || p.policyname, ', '))
  from pg_policies p
 where p.schemaname = 'public' and p.permissive = 'PERMISSIVE' and p.cmd in ('SELECT', 'ALL')
   and p.roles && array['anon', 'public']::name[] and coalesce(p.qual, 'true') = 'true';

select pg_temp.res('04 the only signed-in "true" read is quote_stage_moves (global stage list)', count(*) = 0,
  string_agg(p.tablename || ':' || p.policyname, ', '))
  from pg_policies p
 where p.schemaname = 'public' and p.permissive = 'PERMISSIVE' and p.cmd in ('SELECT', 'ALL')
   and p.roles && array['authenticated']::name[] and coalesce(p.qual, 'true') = 'true'
   and p.tablename <> 'quote_stage_moves';

select pg_temp.res('05 every permissive policy on a studio table (org_id) is studio / user / HQ scoped', count(*) = 0,
  string_agg(p.tablename || ':' || p.policyname, ', '))
  from pg_policies p
 where p.schemaname = 'public' and p.permissive = 'PERMISSIVE'
   and p.roles && array['anon', 'authenticated', 'public']::name[]
   and exists (select 1 from information_schema.columns c
                where c.table_schema = 'public' and c.table_name = p.tablename and c.column_name = 'org_id')
   and coalesce(p.qual, '') || coalesce(p.with_check, '') !~ '(current_org_id|auth\.uid|is_platform_admin|helm_is_hq|_hq_)';

-- ---- 06-07 table privileges ----------------------------------------------------------------------------------------
select pg_temp.res('06 signed-out (anon) holds no privilege on any public table or view', count(*) = 0,
  string_agg(c.relname, ', '))
  from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f')
   and (has_table_privilege('anon', c.oid, 'select, insert, update, delete, truncate, references, trigger')
        or has_any_column_privilege('anon', c.oid, 'select, insert, update, references'));

select pg_temp.res('07 no dead signed-in table privilege (a privilege no permissive policy uses)', count(*) = 0,
  string_agg(g.t || ':' || g.cmd, ', '))
  from (select c.relname t, x.cmd
          from pg_class c cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) x(cmd)
         where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relrowsecurity
           and (has_table_privilege('authenticated', c.oid, x.cmd)
                or (x.cmd <> 'DELETE' and has_any_column_privilege('authenticated', c.oid, x.cmd)))) g
 where not exists (select 1 from pg_policies p
                    where p.schemaname = 'public' and p.tablename = g.t and p.permissive = 'PERMISSIVE'
                      and (p.cmd = g.cmd or p.cmd = 'ALL') and p.roles && array['authenticated', 'public']::name[]);

select pg_temp.res('08 secret / bookkeeping tables: no signed-in or signed-out privilege at all', count(*) = 0,
  string_agg(t, ', '))
  from unnest(array['auth_password_attempts', 'auth_mfa_verify_attempts', 'auth_mfa_attempts', 'auth_rate_hits',
                    'privacy_pin', 'privacy_pin_attempts', 'quote_otps', 'pkg_otps', 'phone_verifications',
                    'staff_links', 'auth_temp_passwords', 'a155_admin_created', 'platform_admins', 'email_unsub_secret',
                    'studio_test_mode', 'studio_test_mode_log', 'delivery_links', 'vendor_request_links',
                    'vendor_invoice_grants', 'task_evidence_grants', 'hq_staff_sessions', 'hq_session_revocations',
                    'mfa_resets', 'captcha_passes', 'helm_env_settings']) t
 where to_regclass('public.' || t) is not null
   and exists (select 1 from unnest(array['anon', 'authenticated']) r
                where has_table_privilege(r, ('public.' || t)::regclass, 'select, insert, update, delete, truncate')
                   or has_any_column_privilege(r, ('public.' || t)::regclass, 'select, insert, update'));

select pg_temp.res('09 OTP / PIN / temp-password tables keep hashes only (no plaintext code / otp / pin / password column)',
  count(*) = 0, string_agg(table_name || '.' || column_name, ', '))
  from information_schema.columns
 where table_schema = 'public'
   and table_name in ('quote_otps', 'pkg_otps', 'phone_verifications', 'privacy_pin', 'auth_temp_passwords', 'a155_admin_created')
   and column_name in ('code', 'otp', 'pin', 'password', 'temp_password', 'plain', 'secret');

-- ---- 10-13 functions -----------------------------------------------------------------------------------------------
select pg_temp.res('10 every SECURITY DEFINER function in public pins its search_path', count(*) = 0,
  string_agg(p.proname, ', '))
  from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosecdef
   and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%');

select pg_temp.res('11 signed-out callers reach no definer with a non-empty search_path (except the 2 phase-1 crew readers)',
  count(*) = 0, string_agg(p.proname, ', '))
  from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosecdef
   and has_function_privilege('anon', p.oid, 'execute')
   and not ('search_path=""' = any(coalesce(p.proconfig, '{}')))
   and p.proname not in ('worker_get_tasks', 'worker_get_equipment');

select pg_temp.res('12 signed-out (anon) can run only the known public / token endpoints (allow-list)', count(*) = 0,
  'not in the allow-list: ' || string_agg(f, ', '))
  from (select p.proname || '(' || oidvectortypes(p.proargtypes) || ')' f
          from pg_proc p where p.pronamespace = 'public'::regnamespace and has_function_privilege('anon', p.oid, 'execute')) x
 where f not in (
    '_a153_money_key(text)', '_r23_enforcing()', '_r55_purge_allowed(uuid, boolean)', 'approval_check_shown(uuid, numeric)',
    'booklet_snapshot_upload_ok(text)', 'client_link_window_days(text)', 'create_payment(uuid)', 'crew_cantwork_ack(uuid, date)',
    'crew_check(uuid, text, numeric, numeric, numeric)', 'crew_claim_shift(uuid, uuid)', 'crew_link_home(uuid)',
    'crew_set_availability(uuid, date, text, text)', 'crew_withdraw_claim(uuid, uuid)', 'delivery_link_get(text)',
    'delivery_link_update(text, text, text, timestamp with time zone)', 'helm_norm_phone(text)', 'invitation_preview(text)',
    'invite_media_guest_read_ok(text)', 'invite_media_on_published_site(text)', 'mfa_ok()',
    'public_booklet_choose(uuid, uuid, integer, text, text)', 'public_booklet_otp_request(uuid)', 'public_booklet_packages(uuid)',
    'public_booklet_pay_terms(uuid)', 'public_booklet_studio(text, text)', 'public_enquiry_info(text)',
    'public_enquiry_submit(text, jsonb)', 'public_event_site(text)', 'public_get_booklet(uuid)',
    'public_get_booklet_image(uuid, text, text)', 'public_get_portal(uuid)', 'public_get_proposal(uuid)', 'public_get_quote(uuid)',
    'public_invite_info(text)', 'public_invite_reveal(text, text)', 'public_invite_rsvp(text, jsonb)', 'public_link_opened(text, uuid)',
    'public_link_studio(text, text, text)', 'public_link_viewed(text, uuid, boolean)', 'public_payment_schedule(uuid)',
    'public_portal_extras(uuid)', 'public_pricing_plans()', 'public_quote_paid_status(uuid)', 'public_quote_ready(uuid)',
    'public_quote_validity(text, uuid)', 'public_request_new_quote(text, uuid, text)', 'public_trial_approval_mode(uuid)',
    'public_trial_payment_sim(uuid)', 'public_trial_sim_payments(text, text)', 'public_trial_simulation(text, text)',
    'public_trial_simulation_for_proposal(text)', 'referral_click(text)', 'referral_lookup(text)', 'request_otp(uuid, text)',
    'request_site_slug()', 'signup_email_preauthorised(text)', 'staff_google_only_for(text)', 'staff_link_cantwork(text)',
    'staff_link_cantwork_ack(text, date)', 'staff_link_view(text)', 'storage_object_name_ok(text, text)', 'storage_op_is_listing()',
    'storage_quota_ok(text, text, jsonb)', 'studio_slug_reserved(text)', 'studio_slug_valid(text)', 'studio_slugify(text)',
    'submit_sales_enquiry(jsonb)', 'submit_suggestion(jsonb)', 'task_proof_upload_ok(text)', 'trial_simulate_payment(uuid, text, text)',
    'trial_storage_write_ok(text)', 'trial_test_approve(uuid, text, text, text, text, text)',
    'trial_test_approve_code(uuid, text, text, text, text, text, text)', 'trial_test_mode_for_token(uuid)', 'try_date(text)',
    'upload_scan_bucket(text)', 'upload_scan_enforced()', 'upload_scan_org(text)', 'upload_scan_read_ok(uuid, text)',
    'vendor_invoice_submit(text, jsonb)', 'vendor_invoice_upload(text, text)', 'vendor_invoice_upload_ok(text)', 'vendor_link_get(text)',
    'vendor_link_respond(text, text, text)', 'verify_and_consent(uuid, text, text, boolean, text, text, text, text)',
    'wa_request_otp(uuid, text, text)', 'wa_verify_and_consent(uuid, text, text, boolean, text, text, text, text)',
    'worker_assignment_updates(uuid)', 'worker_checkin_equipment(uuid, uuid, numeric)', 'worker_evidence_upload(uuid, uuid, text, text)',
    'worker_get_equipment(uuid)', 'worker_get_tasks(uuid)', 'worker_respond(uuid, uuid, text)',
    'worker_respond_evidence(uuid, uuid, text, text, text, integer, text[])'
 );

select pg_temp.res('13 Supabase Auth hooks run for supabase_auth_admin only', count(*) > 0 and bool_and(ok),
  string_agg(case when not ok then f end, ', '))
  from (select p.oid::regprocedure::text f,
               not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('authenticated', p.oid, 'execute')
               and (not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin')
                    or has_function_privilege('supabase_auth_admin', p.oid, 'execute')) ok
          from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname ~ '^hook_') h;

select pg_temp.res('14 every view in public runs with the caller''s rights (security_invoker) or is closed to the app',
  count(*) = 0, string_agg(c.relname, ', '))
  from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'v'
   and not coalesce('security_invoker=true' = any(c.reloptions) or 'security_invoker=on' = any(c.reloptions), false)
   and (has_table_privilege('authenticated', c.oid, 'select') or has_table_privilege('anon', c.oid, 'select'));

-- ---- 15-19 behaviour -------------------------------------------------------------------------------------------------
-- 15 another studio's admin sees none of studio A's rows
select auth.login_as((select id from auth.users where email = 'b_admin@b.test'));
select (select count(*) from public.quotes where org_id = 'a0000000-0000-4000-8000-000000000001')
     + (select count(*) from public.organizations where id = 'a0000000-0000-4000-8000-000000000001')
     + (select count(*) from public.profiles where org_id = 'a0000000-0000-4000-8000-000000000001')
     + (select count(*) from public.role_access where org_id = 'a0000000-0000-4000-8000-000000000001')
     + (select count(*) from public.audit_log where org_id = 'a0000000-0000-4000-8000-000000000001') as x15 \gset
select (select count(*) from public.quotes where org_id = 'b0000000-0000-4000-8000-000000000001') as own15 \gset
select auth.logout();
select pg_temp.res('15 studio B admin sees 0 of studio A''s quotes / studio / members / access / activity rows (sees own)',
  :x15 = 0 and :own15 > 0, 'A rows seen: ' || :x15 || ', own quotes: ' || :own15);

-- 16 a bare sign-up (auth user, no studio) gets nothing
do $$ declare v uuid; begin v := auth.seed_user('b391-bare@x.test'); end $$;
select auth.login_as((select id from auth.users where email = 'b391-bare@x.test'));
select coalesce(public.is_admin(), false) as adm16, public.current_org_id() is null as noorg16,
       (select count(*) from public.quotes) + (select count(*) from public.organizations) as rows16,
       (select count(*) from (select distinct area from public.role_access) a) as areas_total16 \gset
select auth.logout();
select auth.login_as((select id from auth.users where email = 'b391-bare@x.test'));
select count(*) filter (where coalesce(public.has_area(a, 'view'), false) or coalesce(public.has_area(a, 'edit'), false)) as areas16
  from (values ('quotes'), ('finance'), ('users'), ('controls'), ('staff'), ('leads'), ('settlement'), ('inventory'), ('audit')) v(a) \gset
select auth.logout();
select pg_temp.res('16 a bare sign-up (no studio): not admin, no studio, no area, sees no quote / studio',
  not :'adm16'::boolean and :'noorg16'::boolean and :rows16 = 0 and :areas16 = 0,
  format('admin=%s no_org=%s rows=%s areas=%s', :'adm16', :'noorg16', :rows16, :areas16));

-- 17 a studio admin can't raise their own plan / seats / trial / sample flag (each refused)
create function pg_temp.refused(p_email text, p_sql text) returns boolean language plpgsql as $$
declare n int;
begin
  perform auth.login_as((select id from auth.users where email = p_email));
  begin
    execute p_sql; get diagnostics n = row_count;
    perform auth.logout();
    raise exception 'b391_done:%', n;
  exception when others then
    perform auth.logout();
    if sqlerrm like 'b391_done:%' then return split_part(sqlerrm, ':', 2)::int = 0; end if;
    return true;
  end;
end $$;
grant execute on function pg_temp.refused(text, text) to authenticated;
select pg_temp.res('17 studio admin cannot raise own plan / seat_limit / trial_ends_at / sample-master flag',
  pg_temp.refused('a_admin@a.test', $q$update public.organizations set plan = 'enterprise' where id = public.current_org_id()$q$)
  and pg_temp.refused('a_admin@a.test', $q$update public.organizations set seat_limit = 999 where id = public.current_org_id()$q$)
  and pg_temp.refused('a_admin@a.test', $q$update public.organizations set trial_ends_at = now() + interval '10 years' where id = public.current_org_id()$q$)
  and pg_temp.refused('a_admin@a.test', $q$update public.organizations set is_sample_master = true where id = public.current_org_id()$q$));

select pg_temp.res('18 a member cannot change their own role / studio, or make themselves HQ',
  pg_temp.refused('a_staff@a.test', $q$update public.profiles set role = 'admin' where id = auth.uid()$q$)
  and pg_temp.refused('a_staff@a.test', $q$update public.profiles set org_id = 'b0000000-0000-4000-8000-000000000001' where id = auth.uid()$q$)
  and pg_temp.refused('a_admin@a.test', $q$insert into public.platform_admins(user_id) values (auth.uid())$q$)
  and pg_temp.refused('a_admin@a.test', $q$update public.role_access set can_edit = true where org_id = 'b0000000-0000-4000-8000-000000000001'$q$));

select pg_temp.res('19 the activity log cannot be edited or deleted by a studio admin (0391: no table privilege)',
  pg_temp.refused('a_admin@a.test', $q$delete from public.audit_log$q$)
  and pg_temp.refused('a_admin@a.test', $q$update public.audit_log set action = 'x'$q$)
  and not has_table_privilege('authenticated', 'public.audit_log', 'insert, update, delete'));

reset role;
do $$ declare n int; f int; r record; begin
  select count(*), count(*) filter (where result <> 'PASS') into n, f from _b391;
  for r in select * from _b391 where result <> 'PASS' loop raise warning '% -> %', r.name, left(r.result, 1500); end loop;
  if f = 0 then raise warning 'B-AUTH-INVARIANTS-0391: ALL PASS (%/%)', n, n;
  else raise warning 'B-AUTH-INVARIANTS-0391: % FAILED of %', f, n; end if;
end $$;
rollback;
