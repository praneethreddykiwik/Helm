#!/usr/bin/env bash
# r232-remove-role-traces-0400.sh - R232 (owner, 19 Nov 2026): supabase/APPLY-0400.sql removes every trace of the roles
# Event coordinator / Designer, on the disposable local cluster (never staging / production), the way the owner runs it:
#   APPLY-0398 (already in) -> DELETE-0398 (both steps) -> APPLY-0400, pasted like the SQL editor (no harness switches).
# Fixture in studio A / B: admin, manager, planner, sales, supervisor, quality, operations and crew logins; an Event
# coordinator (event lead, history: quote, task, audit row, staff record) and a Designer to be deleted; a studio owner
# who still has Designer (DELETE-0398 never deletes an owner); a waiting 24-hour admin change to Event coordinator; the
# traces 0400 must remove (role_access, invitations + their e-mail rows, per-role notification settings, sign-in /
# event-ready / WhatsApp forward / vendor payer settings, staff role words, trial sample staff, escalation history).
# Proves:
#   1 the SAFETY GATE: with a coordinator login left APPLY-0400 changes nothing (row 01 "run DELETE-0398 first");
#     with only the owner left: nothing ("reassign first"); with the waiting admin change: nothing ("cancel first");
#   2 after APPLY-0400 every check row is ok and no coordinator / designer trace is left (rows, settings, seeds,
#     functions, constraints refuse them) - free-text staff roles kept, Crew kept, history rows kept, copies in _r398_backup;
#   3 every other role behaves EXACTLY as before (tests/db/r232-probe-0400.sql before vs after: access matrix + has_area
#     per login, invitations, role changes, a new studio's and a new free trial's set-up, the escalation ladder, sign-in
#     notices, closure / restore approvers, bell visibility, labels) - the only difference is the first ladder step's name;
#   4 a second APPLY-0400 is a no-op (same data, same functions, same constraints, no new backup rows).
# Prints R232-REMOVE-ROLE-TRACES-0400: PASS. NOT rolled back (APPLY commits) - runs last.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
A=supabase/APPLY-0400.sql; F=supabase/DELETE-0398-RETIRED-ROLE-USERS.sql; P=tests/db/r232-probe-0400.sql
HARNESS_OPTS="${PGOPTIONS:-}"
export PGOPTIONS=""          # like the SQL editor: none of the run-all.sh switches
q() { psql -X -q -A -t -v ON_ERROR_STOP=1 -c "$1"; }
fail=0; ok() { if [ "$2" = "t" ] || [ "$2" = "true" ]; then echo "  ok   $1"; else echo "  FAIL $1 ($2)"; fail=1; fi; }
step2() { awk '/^-- STEP 2 \(deletes\)/{f=1} f' "$F" | sed "s/v_expected int := null;/v_expected int := $1;/"; }
apply() { psql -X -q -A -t -F '|' -f "$A" 2>&1; }
probe() { PGOPTIONS="$HARNESS_OPTS -c helm.r400_remove=on -c helm.retired_role_gate=on" psql -X -q -A -t -f "$P" 2>&1; }
# everything 0400 may touch (the 0400 helpers themselves left out): data, function bodies, constraints, backups
snap() { q "select md5(concat_ws('#',
  (select string_agg(t::text, ',' order by t::text) from public.role_access t),
  (select string_agg(t::text, ',' order by t::text) from public.invitations t),
  (select string_agg(t::text, ',' order by t::text) from public.invite_email_outbox t),
  (select string_agg(t::text, ',' order by t::text) from public.notification_prefs t),
  (select string_agg(t::text, ',' order by t::text) from public.signin_notice_settings t),
  (select string_agg(t::text, ',' order by t::text) from public.event_ready_alert_settings t),
  (select string_agg(t::text, ',' order by t::text) from public.comms_settings t),
  (select string_agg(t::text, ',' order by t::text) from public.vendor_bill_settings t),
  (select string_agg(t::text, ',' order by t::text) from public.crew_members t),
  (select string_agg(t::text, ',' order by t::text) from public.helm_trial_seed_manifest t),
  (select string_agg(t::text, ',' order by t::text) from public.task_escalation_steps t),
  (select string_agg(t::text, ',' order by t::text) from public.profiles t),
  (select string_agg(t::text, ',' order by t::text) from public.team_admin_changes t),
  (select count(*)::text from public._r398_backup),
  (select string_agg(p.oid::regprocedure::text || md5(pg_get_functiondef(p.oid)), ',' order by p.oid::regprocedure::text) from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and p.proname !~ '^_r400_'
      and p.proname not in ('_r398_retired_roles', '_r398_retired_roles__pre0400')),
  (select string_agg(c.conrelid::regclass::text || c.conname || pg_get_constraintdef(c.oid) || c.convalidated::text, ',' order by c.conrelid::regclass::text, c.conname)
     from pg_constraint c where c.connamespace = 'public'::regnamespace)))"; }

# ---- fixture (as the database, the 0398 guard off for the set-up only) ----------------------------------------------
psql -X -q -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
do $$ declare orgA uuid := 'a0000000-0000-4000-8000-000000000001'; orgB uuid := 'b0000000-0000-4000-8000-000000000001';
  qA uuid := 'a0000000-0000-4000-8000-00000000da01'; e text; u uuid; c uuid; d uuid; bo uuid; inv uuid; v int; begin
  perform set_config('helm.retired_role_gate', 'off', true);
  perform set_config('helm.r397_plan_lock', 'off', true);
  foreach e in array array['r232_mgr@a.test:manager:Manu Manager', 'r232_plan@a.test:planner:Pia Planner', 'r232_sup@a.test:supervisor:Sid Supervisor',
                           'r232_qa@a.test:quality:Qadir QA', 'r232_ops@a.test:operations:Ola Ops', 'r232_crew@a.test:crew:Cruz Crew',
                           'r232_coord@a.test:coordinator:Cora Coord', 'r232_des@a.test:designer:Dev Designer'] loop
    select id into u from auth.users where email = split_part(e, ':', 1);
    if u is null then u := auth.seed_user(split_part(e, ':', 1)); end if;
    insert into public.profiles(id, email, full_name, role, org_id, must_change_password, created_at)
      values (u, split_part(e, ':', 1), split_part(e, ':', 3), split_part(e, ':', 2), orgA, false, now())
    on conflict (id) do update set role = excluded.role, org_id = excluded.org_id, full_name = excluded.full_name;
  end loop;
  insert into auth.mfa_factors(user_id, status) select id, 'verified' from auth.users where email = 'a_admin@a.test'
     and not exists (select 1 from auth.mfa_factors f join auth.users x on x.id = f.user_id where x.email = 'a_admin@a.test' and f.status = 'verified');
  select id into c from auth.users where email = 'r232_coord@a.test';
  select id into d from auth.users where email = 'r232_des@a.test';
  -- studio B's owner still has Designer (DELETE-0398 never deletes an owner)
  bo := auth.seed_user('r232_bown@b.test');
  insert into public.profiles(id, email, full_name, role, org_id, must_change_password, created_at)
    values (bo, 'r232_bown@b.test', 'Bea Owner', 'designer', orgB, false, now())
  on conflict (id) do update set role = excluded.role, org_id = excluded.org_id, full_name = excluded.full_name;
  update public.organizations set created_by = bo where id = orgB;
  -- history of the coordinator: event lead, a task, an audit row, a linked staff record (role words copied from the login)
  update public.quotes set manager_id = c, deleted_at = null, status = 'confirmed', is_demo = false,
         event_date = (now() + interval '2 days')::date where id = qA;
  insert into public.event_tasks(quote_id, org_id, category, title, created_by) values (qA, orgA, 'setup', 'R232 coord task', c);
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, org_id) values (c, 'r232_coord@a.test', 'quote.update', 'quotes', qA::text, orgA);
  insert into public.crew_members(id, org_id, name, phone, email, role, profile_id, active, department) values
    ('a0000000-0000-4000-8000-0000000c2301', orgA, 'Cora Coord', '+919800002301', 'r232_coord@a.test', 'Event coordinator', c, true, 'Office'),
    ('a0000000-0000-4000-8000-0000000c2302', orgA, 'Dina Draws', '+919800002302', null, 'Designer', null, true, 'Decor'),
    ('a0000000-0000-4000-8000-0000000c2303', orgA, 'Gita Guest', '+919800002303', null, 'Guest coordinator', null, true, 'Hospitality'),
    ('a0000000-0000-4000-8000-0000000c2304', orgA, 'Lal Lights', '+919800002304', null, 'Lead designer', null, true, 'Decor'),
    ('a0000000-0000-4000-8000-0000000c2305', orgB, 'Eve Events', '+919800002305', null, ' event coordinator ', null, true, 'Office'),
    ('a0000000-0000-4000-8000-0000000c2321', orgA, 'R232 Desk', '+919000023211', 'desk232@example.org', 'Guest desk', null, true, 'Guests');
  -- old studio access matrix (seeded before 0398 skipped the two roles)
  perform public._a49_seed_clean_matrix(orgA); perform public._a143_seed_role_defaults(orgA);
  perform public._a49_seed_clean_matrix(orgB); perform public._a143_seed_role_defaults(orgB);
  -- invitations: a cancelled coordinator one (with its e-mail row), an accepted designer one, an open planner one (stays)
  insert into public.invitations(org_id, email, role, status) values (orgA, 'old_coord@x.test', 'coordinator', 'revoked') returning id into inv;
  insert into public.invite_email_outbox(invitation_id, org_id, email, status) values (inv, orgA, 'old_coord@x.test', 'sent');
  insert into public.invitations(org_id, email, role, status) values (orgA, 'old_des@x.test', 'designer', 'accepted');
  insert into public.invitations(org_id, email, role, status) values (orgA, 'r232_keep@x.test', 'planner', 'pending');
  -- per-role notification settings + studio settings lists naming the two roles
  insert into public.notification_prefs(org_id, role, type, channel, enabled) values
    (orgA, 'coordinator', 'payment_received', 'in_app', false), (orgA, 'designer', 'payment_received', 'email', false),
    (orgA, 'manager', 'payment_received', 'email', false), (orgA, '*', 'payment_received', 'sms', false);
  insert into public.signin_notice_settings(org_id, mode, roles) values (orgA, 'every', array['admin', 'coordinator', 'manager', 'designer', 'sales'])
    on conflict (org_id) do update set roles = excluded.roles, mode = excluded.mode;
  insert into public.event_ready_alert_settings(org_id, notify_roles) values (orgA, array['manager', 'coordinator', 'supervisor'])
    on conflict (org_id) do update set notify_roles = excluded.notify_roles;
  insert into public.comms_settings(org_id, wa_forward_roles) values (orgA, '{"coordinator": ["payment_received"], "manager": ["payment_received"]}')
    on conflict (org_id) do update set wa_forward_roles = excluded.wa_forward_roles;
  insert into public.vendor_bill_settings(org_id, payer_kind, payer_role) values (orgB, 'role', 'designer')
    on conflict (org_id) do update set payer_kind = 'role', payer_role = 'designer';
  -- the free-trial sample data has a staff member with the exact label
  select max(version) into v from public.helm_trial_seed_manifest where is_current;
  update public.helm_trial_seed_manifest set payload = jsonb_set(payload, '{tables,crew_members}',
           (payload -> 'tables' -> 'crew_members') || jsonb_build_array(jsonb_build_object('id', 'a5a5a5a5-0166-4000-8000-00000000c232',
             'name', E'Demo · Ravi Sketch', 'phone', '+91 00000 00232', 'role', 'Designer', 'department', 'Decor', 'active', true,
             'org_id', 'a5a5a5a5-0166-4000-8000-000000000001', 'skills', '[]'::jsonb, 'attributes', '{}'::jsonb, 'is_demo', true)))
   where version = v;
  -- a waiting 24-hour change of an admin to Event coordinator
  insert into public.team_admin_changes(org_id, target_user, kind, new_role, requested_by, effective_at)
    values (orgA, (select id from auth.users where email = 'a_admin@a.test'), 'demote', 'coordinator',
            (select id from auth.users where email = 'a_admin@a.test'), now() + interval '1 day');
end $$;
SQL
[ $? -eq 0 ] || { echo "fixture failed"; exit 1; }
# escalation history from the old ladder (a step named "coordinator", told to the coordinator = event lead): committed
PGOPTIONS="$HARNESS_OPTS -c helm.r400_remove=on" psql -X -q -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
insert into public.event_tasks (id, quote_id, org_id, category, title, crew_id, assignee_name, assignee_phone, status, planned_start, remind_before, is_special, remind_every_min)
  values ('a0000000-0000-4000-8000-0000000f2320', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-000000000001', 'Guests', 'R232 old task',
          'a0000000-0000-4000-8000-0000000c2321', 'R232 Desk', '+91 90000 23211', 'assigned', date_trunc('minute', now()) - interval '1 minute', '{}', true, 5);
select public.task_reminder_tick(date_trunc('minute', now()) - interval '1 minute');
SQL
ok "fixture: an old escalation step named coordinator, told to the coordinator (history)" "$(q "select exists (select 1 from public.task_escalation_steps where task_id = 'a0000000-0000-4000-8000-0000000f2320' and level = 'coordinator' and recipients::text like '%Cora Coord%') and exists (select 1 from public.notifications where kind = 'task_escalated' and detail ->> 'label' like '%Escalated to coordinator%')")"
NOTIF_OLD="$(q "select count(*) from public.notifications where detail::text ~* 'coordinator'")"

# ---- 1) the safety gate --------------------------------------------------------------------------------------------
CB_BEFORE="$(PGOPTIONS="$HARNESS_OPTS -c helm.retired_role_gate=on" psql -X -q -A -t 2>&1 <<'SQL'
begin;
do $$ declare u uuid; begin
  select id into u from auth.users where email = 'a_admin@a.test';
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', 'a_admin@a.test', 'aal', 'aal2',
    'amr', jsonb_build_array(jsonb_build_object('method', 'totp', 'timestamp', extract(epoch from now())::bigint)))::text, false);
end $$;
set role authenticated;
do $$ begin perform public.create_invitation('r232crew0@x.test', 'crew'); raise notice 'C=ok';
exception when others then raise notice 'C=err:%', sqlstate; end $$;
rollback;
SQL
)"
CB_BEFORE="$(echo "$CB_BEFORE" | sed -n 's/^NOTICE: *//p' | grep '^C=')"
S0="$(snap)"
O="$(apply)"
ok "gate: a coordinator / designer login left -> row 01 says run DELETE-0398 first (ok false)" "$(grep -q '^01 STOP - run DELETE-0398 first: 2 login(s)[^|]*|f$' <<<"$O" && echo t || echo "$O" | grep '^01')"
ok "gate: nothing was changed (data, functions, constraints, backups)" "$( [ "$(snap)" = "$S0" ] && echo t || echo changed)"
N="$(awk '/^-- STEP 1 \(read-only\)/{f=1} /^-- STEP 2 \(deletes\)/{f=0} f' "$F" | psql -X -q -A -t -F '|' | grep -c 'r232_')"
ok "DELETE-0398 step 1 lists the coordinator + designer (not the owner)" "$( [ "$N" = 2 ] && echo t || echo "$N")"
O="$(step2 2 | psql -X -q -A -t -F '|' 2>&1)"
ok "DELETE-0398 step 2 ran (5 check rows ok)" "$( [ "$(echo "$O" | grep -c '|t$')" = 5 ] && echo t || echo "$O" | tail -4)"
S1="$(snap)"
O="$(apply)"
ok "gate: only the studio owner with Designer left -> row 01 says reassign first (ok false), nothing changed" "$(grep -q '^01 STOP - reassign first: 1 studio owner[^|]*|f$' <<<"$O" && [ "$(snap)" = "$S1" ] && echo t || echo "$O" | grep '^01')"
q "update public.profiles set role = 'admin' where email = 'r232_bown@b.test'" >/dev/null
S2="$(snap)"
O="$(apply)"
ok "gate: a waiting admin change to Event coordinator -> row 01 says cancel first (ok false), nothing changed" "$(grep -q '^01 STOP - cancel first: 1 waiting[^|]*|f$' <<<"$O" && [ "$(snap)" = "$S2" ] && echo t || echo "$O" | grep '^01')"
q "update public.team_admin_changes set status = 'cancelled', decided_at = now() where status = 'pending' and new_role = 'coordinator'" >/dev/null
# role_access rows of the two roles are still there (DELETE-0398 kept them: the owner still had Designer)
ok "before 0400: the traces are there (role_access, invitations, settings, staff words, manifest, escalation step)" "$(q "select exists (select 1 from public.role_access where role in ('coordinator','designer')) and exists (select 1 from public.invitations where role in ('coordinator','designer')) and exists (select 1 from public.notification_prefs where role = 'coordinator') and exists (select 1 from public.crew_members where role = 'Designer') and exists (select 1 from public.task_escalation_steps where level = 'coordinator')")"

# ---- 3a) every other role BEFORE ------------------------------------------------------------------------------------
B="$(probe)"
[ -n "${R232_DEBUG_DIR:-}" ] && echo "$B" > "$R232_DEBUG_DIR/probe-before.txt"
ok "probe before ran" "$(grep -q '^matrix ' <<<"$B" && ! grep -qE '^(psql|ERROR)' <<<"$B" && echo t || echo "$(echo "$B" | wc -l) lines: $(echo "$B" | grep -E 'ERROR|psql' | head -3) $(echo "$B" | head -3)")"

# ---- 2) APPLY-0400 --------------------------------------------------------------------------------------------------
BK0="$(q "select count(*) from public._r398_backup")"
O="$(apply)"
ok "APPLY-0400: every check row ok (15 numbered + the staff list)" "$( [ "$(echo "$O" | grep -E '^[0-9]{2} ' | grep -c '|t$')" = 15 ] && ! grep -qE 'ERROR|\|f$' <<<"$O" && echo t || echo "$O" | grep -E 'ERROR|\|f$' | head -5)"
ok "APPLY-0400 lists the staff records whose role words were removed (Cora, Dina, Eve + any left by earlier suites)" "$(grep -q '^list staff record "Cora Coord" (Studio A): role words "Event coordinator" removed|t$' <<<"$O" && grep -q '^list staff record "Dina Draws" (Studio A): role words "Designer" removed|t$' <<<"$O" && grep -q '^list staff record "Eve Events" (Studio B): role words " event coordinator " removed|t$' <<<"$O" && [ "$(grep -E '^list' <<<"$O" | grep -cE 'Gita Guest|Lal Lights')" = 0 ] && echo t || echo "$O" | grep '^list')"
ok "no role_access / invitation / notification setting of the two roles; the planner invite kept" "$(q "select not exists (select 1 from public.role_access where role in ('coordinator','designer')) and not exists (select 1 from public.invitations where role in ('coordinator','designer')) and not exists (select 1 from public.invite_email_outbox where email = 'old_coord@x.test') and not exists (select 1 from public.notification_prefs where role in ('coordinator','designer')) and exists (select 1 from public.invitations where email = 'r232_keep@x.test' and role = 'planner' and status = 'pending') and (select count(*) from public.notification_prefs where org_id = 'a0000000-0000-4000-8000-000000000001' and type = 'payment_received') = 2")"
ok "settings lists: the two roles taken out, the rest kept in order; vendor payer -> admin" "$(q "select (select roles = array['admin','manager','sales'] from public.signin_notice_settings where org_id = 'a0000000-0000-4000-8000-000000000001') and (select notify_roles = array['manager','supervisor'] from public.event_ready_alert_settings where org_id = 'a0000000-0000-4000-8000-000000000001') and (select wa_forward_roles = '{\"manager\": [\"payment_received\"]}'::jsonb from public.comms_settings where org_id = 'a0000000-0000-4000-8000-000000000001') and (select payer_role = 'admin' and payer_kind = 'role' from public.vendor_bill_settings where org_id = 'b0000000-0000-4000-8000-000000000001')")"
ok "staff: exact labels removed (linked + unlinked + other case / spaces), free text kept, records kept" "$(q "select (select role is null from public.crew_members where id = 'a0000000-0000-4000-8000-0000000c2301') and (select role is null from public.crew_members where id = 'a0000000-0000-4000-8000-0000000c2302') and (select role is null from public.crew_members where id = 'a0000000-0000-4000-8000-0000000c2305') and (select role = 'Guest coordinator' from public.crew_members where id = 'a0000000-0000-4000-8000-0000000c2303') and (select role = 'Lead designer' from public.crew_members where id = 'a0000000-0000-4000-8000-0000000c2304') and (select count(*) = 5 from public.crew_members where id::text like 'a0000000-0000-4000-8000-0000000c230%')")"
ok "trial sample data: the Designer sample staff keeps its row without the role words" "$(q "select exists (select 1 from public.helm_trial_seed_manifest m, jsonb_array_elements(m.payload -> 'tables' -> 'crew_members') e where m.is_current and e ->> 'name' like '%Ravi Sketch' and e -> 'role' = 'null'::jsonb)")"
ok "escalation history relabelled lead (same people), old notices / activity left as written" "$(q "select (select level = 'lead' and recipients::text like '%Cora Coord%' and recipients::text like '%\"lead\"%' and recipients::text not like '%coordinator%' from public.task_escalation_steps where task_id = 'a0000000-0000-4000-8000-0000000f2320') and (select count(*) from public.notifications where detail::text ~* 'coordinator') = $NOTIF_OLD")"
ok "history kept: the quote, the coordinator's task and audit row, every user except the 2 deleted" "$(q "select exists (select 1 from public.quotes where id = 'a0000000-0000-4000-8000-00000000da01') and exists (select 1 from public.event_tasks where title = 'R232 coord task') and exists (select 1 from public.audit_log where actor_email = 'r232_coord@a.test') and (select count(*) from public.profiles where email like 'r232\_%') = 7")"
ok "copies of every removed / changed row in _r398_backup (kind r400_*)" "$(q "select (select count(distinct kind) from public._r398_backup where kind like 'r400\_%') = 11 and exists (select 1 from public._r398_backup where kind = 'r400_invitations' and row_data ->> 'email' = 'old_coord@x.test') and exists (select 1 from public._r398_backup where kind = 'r400_invitations' and row_data ->> 'email' = 'old_des@x.test') and exists (select 1 from public._r398_backup where kind = 'r400_invite_email_outbox' and row_data ->> 'email' = 'old_coord@x.test') and (select count(*) from public._r398_backup where kind = 'r400_crew_members' and row_data ->> 'id' like 'a0000000-0000-4000-8000-0000000c230%') = 3 and exists (select 1 from public._r398_backup where kind = 'r400_role_access' and row_data ->> 'role' = 'designer')")"
ok "no live function names the two roles (except the 0398 guard, the cost matcher, the UAE job title, __pre copies)" "$(q "select not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosrc ~* 'coordinator|designer' and p.proname !~ '__pre0400$' and p.proname !~ '^_r398_' and p.proname not in ('_r21_category', '_demo_seed_ae', '_demo_seed__pre0166'))")"
ok "kept old bodies (__pre0400): 29 copies, none callable by the app" "$(q "select count(*) = 29 and bool_and(not has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('service_role', p.oid, 'execute')) from pg_proc p where p.proname like '%\_\_pre0400'")"
T="$(psql -X -q -A -t 2>&1 <<'SQL'
set helm.retired_role_gate = 'off';
do $$ declare e text; r text := ''; begin
  foreach e in array array[
    'insert into public.profiles(id, email, role, org_id) values (gen_random_uuid(), ''x1@x.test'', ''coordinator'', ''a0000000-0000-4000-8000-000000000001'')',
    'insert into public.profiles(id, email, role, org_id) values (gen_random_uuid(), ''x2@x.test'', ''designer'', ''a0000000-0000-4000-8000-000000000001'')',
    'insert into public.invitations(org_id, email, role) values (''a0000000-0000-4000-8000-000000000001'', ''x3@x.test'', ''designer'')',
    'insert into public.role_access(org_id, role, area, can_view, can_edit) values (''a0000000-0000-4000-8000-000000000001'', ''coordinator'', ''zz'', true, true)',
    'insert into public.notification_prefs(org_id, role, type, channel) values (''a0000000-0000-4000-8000-000000000001'', ''designer'', ''x'', ''email'')',
    'update public.signin_notice_settings set roles = roles || ''{coordinator}''::text[]',
    'update public.event_ready_alert_settings set notify_roles = notify_roles || ''{designer}''::text[]',
    'update public.comms_settings set wa_forward_roles = wa_forward_roles || ''{"coordinator": []}''',
    'update public.vendor_bill_settings set payer_role = ''coordinator''',
    'update public.task_escalation_steps set level = ''coordinator''' ] loop
    begin execute e; r := r || 'ACCEPTED '; exception when check_violation then r := r || 'refused '; when others then r := r || sqlstate || ' '; end;
  end loop;
  raise notice 'R=%', r;
end $$;
SQL
)"
ok "the database refuses the two roles everywhere (profiles, invitations, role_access, settings, escalation)" "$(grep -q 'R=refused refused refused refused refused refused refused refused refused refused' <<<"$T" && echo t || echo "$T" | tail -1)"
ok "Crew kept: login, matrix rows, still a valid role" "$(q "select (select role from public.profiles where email = 'r232_crew@a.test') = 'crew' and exists (select 1 from public.role_access where role = 'crew' and org_id = 'a0000000-0000-4000-8000-000000000001') and public._valid_role('crew')")"
# Crew available again (owner 19 Nov 2026): a signed-in admin can invite + give Crew; Event coordinator / Designer refused
C="$(PGOPTIONS="$HARNESS_OPTS -c helm.retired_role_gate=on" psql -X -q -A -t 2>&1 <<'SQL'
begin;
create or replace function pg_temp.as_admin(p_sql text) returns text language plpgsql as $$
declare r text; u uuid; begin
  select id into u from auth.users where email = 'a_admin@a.test';
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', 'a_admin@a.test', 'aal', 'aal2',
    'amr', jsonb_build_array(jsonb_build_object('method', 'totp', 'timestamp', extract(epoch from now())::bigint)))::text, false);
  perform set_config('role', 'authenticated', false);
  begin execute p_sql into r; r := 'ok';
  exception when others then r := 'err:' || sqlstate; end;
  execute 'reset role'; perform set_config('request.jwt.claims', '', false);
  return r;
end $$;
select pg_temp.as_admin($q$select public.create_invitation('r232crew@x.test', 'crew')::text$q$);
select pg_temp.as_admin(format('select public.team_set_role(%L, ''crew'')::text', (select id from auth.users where email = 'r232_ops@a.test')));
select role from public.profiles where email = 'r232_ops@a.test';
select pg_temp.as_admin($q$select public.create_invitation('r232co@x.test', 'coordinator')::text$q$);
select pg_temp.as_admin($q$select public.create_invitation('r232de@x.test', 'designer')::text$q$);
select pg_temp.as_admin(format('select public.team_set_role(%L, ''designer'')::text', (select id from auth.users where email = 'r232_plan@a.test')));
rollback;
SQL
)"
C="C=$(echo "$C" | grep -vE '^(BEGIN|CREATE|ROLLBACK)' | tr '\n' ' ' | sed 's/ $//')"
ok "Crew available again: admin invites Crew + changes a member to Crew; Event coordinator / Designer refused (invite, role change)" "$(grep -qE '^C=ok ok crew err:[0-9A-Z]{5} err:[0-9A-Z]{5} err:[0-9A-Z]{5}$' <<<"$C" && echo t || echo "$C" | tail -2)"
CB="$(echo "$CB_BEFORE")"
ok "before 0400 (0398 only) Crew was refused for an invite (so the change above is the 0400 one)" "$(grep -qE '^C=err:22023' <<<"$CB" && echo t || echo "$CB")"

# ---- 3b) every other role AFTER = BEFORE ----------------------------------------------------------------------------
AF="$(probe)"
[ -n "${R232_DEBUG_DIR:-}" ] && echo "$AF" > "$R232_DEBUG_DIR/probe-after.txt"
ok "probe after ran" "$(grep -q '^matrix ' <<<"$AF" && ! grep -qE '^(psql|ERROR)' <<<"$AF" && echo t || echo "$(echo "$AF" | wc -l) lines: $(echo "$AF" | grep -E 'ERROR|psql' | head -3) $(echo "$AF" | head -3)")"
DIFF="$(diff <(echo "$B") <(echo "$AF"))"
ok "every other role behaves exactly as before ($(echo "$B" | wc -l | tr -d ' ') facts: matrix, has_area, invites, role changes, new studio, new trial, escalation, sign-in notices, approvers, bell, labels)" "$( [ -z "$DIFF" ] && echo t || echo "$DIFF" | head -8)"
ok "the probe covered the escalation ladder (3 steps, the event lead's step = supervisor), a new trial and a new studio" "$([ "$(grep -c '^esc step ' <<<"$AF")" = 3 ] && grep -qE '^esc step 0\|sent "L1" .*Sid Supervisor:"L1"' <<<"$AF" && grep -qF 'trial matrix manager quotes|' <<<"$AF" && grep -qF 'new studio matrix supervisor tasks|' <<<"$AF" && grep -qF 'invite planner|ok:' <<<"$AF" && echo t || echo "$AF" | grep -E '^esc step' | head -3)"

# r235 (0401): the bell window copy is made from the live _r388_vis; the owner runs APPLY-0401 after APPLY-0400 (or again
# after it), which re-makes the copy from the 0400 rule - the same here (a no-op before 0401)
q "select public._r401_sync() where to_regprocedure('public._r401_sync()') is not null" >/dev/null
# ---- 4) a second run is a no-op ------------------------------------------------------------------------------------
S3="$(snap)"; BK1="$(q "select count(*) from public._r398_backup")"
O="$(apply)"
ok "second APPLY-0400: every check row ok" "$( [ "$(echo "$O" | grep -E '^[0-9]{2} ' | grep -c '|t$')" = 15 ] && ! grep -qE 'ERROR|\|f$' <<<"$O" && echo t || echo "$O" | grep -E 'ERROR|\|f$' | head -3)"
ok "second APPLY-0400 changed nothing (data, functions, constraints) and wrote no new backup rows" "$( [ "$(snap)" = "$S3" ] && [ "$(q "select count(*) from public._r398_backup")" = "$BK1" ] && [ "$BK1" -gt "$BK0" ] && echo t || echo "changed")"

if [ "$fail" = 0 ]; then echo "R232-REMOVE-ROLE-TRACES-0400: PASS"; else echo "R232-REMOVE-ROLE-TRACES-0400: FAIL"; exit 1; fi
