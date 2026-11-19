#!/usr/bin/env bash
# r229-delete-retired-users-0398.sh - the owner-run supabase/DELETE-0398-RETIRED-ROLE-USERS.sql, both steps, on the
# disposable local cluster (never staging / production). Fixture in studio A: an Event coordinator and a Designer with
# history (a quote they manage / confirmed, tasks they created, an audit row, a chat message, a linked staff record,
# a sign-in session), plus an admin, a Planner and a Crew login that must survive. Runs WITHOUT the test-harness
# switches (like the SQL editor): step 1 lists exactly the 2; step 2 with no number / a wrong number stops and changes
# nothing; with the right number: the 2 logins are gone, copies in _r398_backup, every history row kept (pointer
# emptied), staff record kept + unlinked, survivors untouched, role_access rows of the two roles deleted (copied),
# check rows all true; a second run with 0 deletes nobody. Prints R229-DELETE-0398: PASS.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
F=supabase/DELETE-0398-RETIRED-ROLE-USERS.sql
# emulate the SQL editor: none of the run-all.sh switches
export PGOPTIONS=""
q() { psql -X -q -A -t -v ON_ERROR_STOP=1 -c "$1"; }
fail=0; ok() { if [ "$2" = "t" ] || [ "$2" = "true" ]; then echo "  ok   $1"; else echo "  FAIL $1 ($2)"; fail=1; fi; }
step1() { awk '/^-- STEP 1 \(read-only\)/{f=1} /^-- STEP 2 \(deletes\)/{f=0} f' "$F"; }
step2() { awk '/^-- STEP 2 \(deletes\)/{f=1} f' "$F" | sed "s/v_expected int := null;/v_expected int := $1;/"; }

psql -X -q -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
do $$ declare orgA uuid := 'a0000000-0000-4000-8000-000000000001'; qA uuid := 'a0000000-0000-4000-8000-00000000da01';
  c uuid; d uuid; pl uuid; cr uuid; conv uuid; e text; begin
  perform set_config('helm.retired_role_gate', 'off', true);
  foreach e in array array['r229d_coord@a.test', 'r229d_design@a.test', 'r229d_plan@a.test', 'r229d_crew@a.test'] loop
    if not exists (select 1 from auth.users where email = e) then perform auth.seed_user(e); end if;
  end loop;
  select id into c from auth.users where email = 'r229d_coord@a.test';
  select id into d from auth.users where email = 'r229d_design@a.test';
  select id into pl from auth.users where email = 'r229d_plan@a.test';
  select id into cr from auth.users where email = 'r229d_crew@a.test';
  insert into public.profiles(id, email, full_name, role, org_id, must_change_password, created_at) values
    (c, 'r229d_coord@a.test', 'Coord One', 'coordinator', orgA, false, now()),
    (d, 'r229d_design@a.test', 'Design One', 'designer', orgA, false, now()),
    (pl, 'r229d_plan@a.test', 'Plan One', 'planner', orgA, false, now()),
    (cr, 'r229d_crew@a.test', 'Crew One', 'crew', orgA, false, now())
  on conflict (id) do update set role = excluded.role, org_id = excluded.org_id, full_name = excluded.full_name;
  update auth.users set last_sign_in_at = now() - interval '2 days' where id in (c, d);
  update public.quotes set manager_id = c, confirmed_by = d where id = qA;
  insert into public.event_tasks(quote_id, org_id, category, title, created_by) values (qA, orgA, 'setup', 'R229 stage', c), (qA, orgA, 'decor', 'R229 flowers', d);
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, org_id) values (c, 'r229d_coord@a.test', 'quote.update', 'quotes', qA::text, orgA);
  insert into public.crew_members(org_id, name, phone, email, role, profile_id, active) values (orgA, 'Coord One', '+919800000229', 'r229d_coord@a.test', 'Event coordinator', c, true);
  insert into auth.sessions(user_id) values (c);
  insert into public.chat_conversations(org_id, kind, title, created_by) values (orgA, 'group', 'R229 chat', c) returning id into conv;
  insert into public.chat_messages(conversation_id, org_id, sender_id, body) values (conv, orgA, d, 'R229 hello');
  insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at)
    values ('coordinator', 'quotes', true, false, orgA, now()), ('designer', 'design', true, true, orgA, now())
    on conflict (role, area, org_id) do nothing;
end $$;
SQL
[ $? -eq 0 ] || { echo "fixture failed"; exit 1; }

# STEP 1: read-only, lists exactly the coordinator + designer
S1="$(step1 | psql -X -q -A -t -F '|' -v ON_ERROR_STOP=1 2>&1)"
ok "step 1 lists the 2 (coordinator + designer), nobody else" "$( [ "$(echo "$S1" | grep -c 'r229d_')" = 2 ] && echo "$S1" | grep -q 'r229d_coord@a.test|Event coordinator' && echo "$S1" | grep -q 'r229d_design@a.test|Designer' && ! echo "$S1" | grep -qE 'r229d_plan|r229d_crew|a_admin' && echo t || echo "$S1")"
N="$(echo "$S1" | grep 'r229d_coord' | awk -F'|' '{print $7}')"
H="$(echo "$S1" | grep 'r229d_coord' | awk -F'|' '{print $6}')"
ok "step 1 counts the coordinator's history rows (>= 4) and people_to_delete" "$( [ "${H:-0}" -ge 4 ] && [ -n "$N" ] && echo t || echo "H=$H N=$N")"
ok "step 1 changed nothing" "$(q "select count(*) = 2 from public.profiles where role in ('coordinator','designer') and email like 'r229d_%'")"

# STEP 2 without a number / with a wrong number: stops, nothing changed
O="$(step2 null | psql -X -q -A -t 2>&1)"
ok "step 2 with no number stops (type the number)" "$(echo "$O" | grep -q 'type the number' && echo t || echo "$O" | head -2)"
O="$(step2 $((N + 1)) | psql -X -q -A -t 2>&1)"
ok "step 2 with a wrong number stops" "$(echo "$O" | grep -q 'STOP: you typed' && echo t || echo "$O" | head -2)"
ok "after the stops nothing was deleted or copied" "$(q "select count(*) = 2 from public.profiles where email in ('r229d_coord@a.test','r229d_design@a.test') and (select count(*) from public._r398_backup where kind = 'profile') = 0")"

# STEP 2 with the right number
O="$(step2 "$N" | psql -X -q -A -t -F '|' 2>&1)"
ok "step 2 ran, every check row ok" "$( [ "$(echo "$O" | grep -c '|t$')" = 5 ] && ! echo "$O" | grep -qE 'ERROR|\|f$' && echo t || echo "$O" | tail -6)"
ok "coordinator + designer logins and profiles gone" "$(q "select not exists (select 1 from auth.users where email in ('r229d_coord@a.test','r229d_design@a.test')) and not exists (select 1 from public.profiles where role in ('coordinator','designer'))")"
ok "admin, Planner and Crew logins untouched" "$(q "select (select p.role from public.profiles p join auth.users u on u.id = p.id where u.email = 'a_admin@a.test') = 'admin' and (select role from public.profiles where email = 'r229d_plan@a.test') = 'planner' and (select role from public.profiles where email = 'r229d_crew@a.test') = 'crew'")"
ok "history kept: quote, 2 tasks, audit row, chat message, staff record - pointers emptied" "$(q "select (select manager_id is null and confirmed_by is null from public.quotes where id = 'a0000000-0000-4000-8000-00000000da01') and (select count(*) = 2 from public.event_tasks where title like 'R229 %' and created_by is null) and exists (select 1 from public.audit_log where actor_email = 'r229d_coord@a.test') and exists (select 1 from public.chat_messages where body = 'R229 hello' and sender_id is null) and exists (select 1 from public.chat_conversations where title = 'R229 chat' and created_by is null) and exists (select 1 from public.crew_members where email = 'r229d_coord@a.test' and profile_id is null)")"
ok "copies in _r398_backup: every profile + login deleted, the staff record, the emptied pointers, the session" "$(q "select (select count(*) from public._r398_backup where kind = 'profile') = $N and (select count(*) from public._r398_backup where kind = 'auth_user') = $N and exists (select 1 from public._r398_backup where kind = 'staff') and exists (select 1 from public._r398_backup where kind = 'ref_nulled' and tbl = 'quotes' and col = 'manager_id') and exists (select 1 from public._r398_backup where kind = 'ref_nulled' and tbl = 'event_tasks') and exists (select 1 from public._r398_backup where kind = 'cascade_row' and tbl = 'auth.sessions')")"
ok "role_access rows of the two removed roles deleted (copied first)" "$(q "select not exists (select 1 from public.role_access where role in ('coordinator','designer')) and exists (select 1 from public._r398_backup where kind = 'role_access' and row_data ->> 'role' = 'coordinator')")"
# a second run with 0
O="$(step2 0 | psql -X -q -A -t -F '|' 2>&1)"
ok "a second run (0 people) deletes nobody, checks ok" "$(echo "$O" | grep -c '|t$' | grep -q '^5$' && q "select (select count(*) from public._r398_backup where kind = 'profile') = $N" || echo "$O" | tail -3)"

if [ "$fail" = 0 ]; then echo "R229-DELETE-0398: PASS"; else echo "R229-DELETE-0398: FAIL"; exit 1; fi
