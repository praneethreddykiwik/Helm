// r232-remove-role-traces.test.mjs - R232 (owner, 19 Nov 2026): "remove ALL traces of Event coordinator / Designer, in
// every studio, free trials and new studios - nothing else changes" + Crew available again. The browser / repo side:
//   1. public/: no role named Event coordinator / Designer anywhere (labels, pickers, boards, tours, help, demo data);
//      the only words left are not the role (cost-category matcher, booklet contact data keys, font licences)
//   2. Crew offered again (no retired role), escalation step 1 = "Event lead" everywhere it is shown
//   3. edge functions: invite labels + escalation e-mail wording
//   4. SQL 0400 + APPLY-0400: safety gate, backups first, deletes only role_access / invitations / notification_prefs
//      rows, never a user / quote / task / payment / message; MANIFEST, run-all (switch + suite last), overrides,
//      release lists; APPLY = header + migration verbatim + check rows in one transaction; ASCII, no session state
import { readFileSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
const rd = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0;
const t = (name, fn) => { try { fn(); n++; console.log('  ok ' + name); } catch (e) { console.error('  FAIL ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; } };

const KEEP = {   // file -> what is allowed to stay (not the role)
  'public/budget-plan.js': /\|coordinator\)\/ \},$/,                      // "event coordinator" fee lines are staff costs
  'public/store-api.js': /cleaning\|helper\|coordinator\|crew\//,           // staff department guess from free text
  'public/booklet.js': /d\.coordinator|coordinator_name|coordinator_phone/, // booklet contact data keys
  'public/role-defaults.js': /R232 \/ 0400: Event coordinator \+ Designer removed/,
};
const files = readdirSync(new URL('../public/', import.meta.url)).filter((f) => /\.(js|html|css|json)$/.test(f) && !/\.min\./.test(f));

t('1 public/: no Event coordinator / Designer role left (only words that are not the role)', () => {
  const bad = [];
  for (const f of files) {
    const p = 'public/' + f;
    rd(p).split('\n').forEach((line, i) => {
      if (!/coordinator|designer/i.test(line)) return;
      if (KEEP[p] && KEEP[p].test(line)) return;
      bad.push(p + ':' + (i + 1) + ': ' + line.trim().slice(0, 120));
    });
  }
  assert.deepEqual(bad, []);
});

t('2 Crew offered again, no retired role; Settings / login / sign-in labels without the two roles', () => {
  const API = rd('public/store-api.js');
  assert.match(API, /const RETIRED_ROLES = \[\];/);
  assert.match(API, /const ALL_ROLES {2}= \["admin", "manager", "planner", "sales", "supervisor", "quality", "operations", "crew", "worker", "client"\];/);
  assert.match(rd('public/signin-notice-ui.js'), /var ALL = \["admin", "manager", "planner", "sales", "supervisor", "quality", "operations", "crew"\];/);
  assert.match(rd('public/login.html'), /sales:"Sales",supervisor:"Supervisor",quality:"Quality engineer",operations:"Operations",crew:"Crew"/);
  assert.match(rd('public/control.html'), /var ROLE_SUGGEST = \{\n {4}crew: {5}\[\["runsheet",false\],\["calendar",false\]\]\n {2}\};/);
  assert.doesNotMatch(rd('public/role-defaults.js'), /designer:/);
  assert.doesNotMatch(rd('public/dashboard.html'), /coordinator: \{|designer: {4}\{/);
});

t('2b escalation step 1 reads "Event lead" (old rows with the old name read the same)', () => {
  const TS = rd('public/task-status.js');
  assert.match(TS, /return \["Worker", "Event lead" \+ plus\(s\[0\]\), "Manager" \+ plus\(s\[1\]\), "Admin" \+ plus\(s\[2\]\)\];/);
  assert.match(TS, /function escLevel\(l\) \{ return l === "admin" \? "admin \/ owner" : l === "manager" \? "manager" : "event lead"; \}/);
  assert.match(TS, /rec = a \? \(\{ manager: 2, admin: 3 \}\)\[\(a\.detail && a\.detail\.level\) \|\| "lead"\] \|\| 1 : 0;/);
  assert.match(rd('public/monitor.js'), /"mon-chip mon-esc is-esc-" \+ \(\{ manager: "manager", admin: "admin" \}\[esc\.detail && esc\.detail\.level\] \|\| "lead"\)/);
  assert.match(rd('public/monitor.css'), /\.mon-chip\.mon-esc\.is-esc-lead\{/);
  assert.match(rd('public/task-reminders-ui.js'), /\[\["tre_s1", "Event lead"\], \["tre_s2", "Manager"\]/);
  assert.match(rd('public/page-tours.js'), /set when the event lead, the manager and the admin \/ owner are told/);
});

t('3 edge functions: invite labels + escalation e-mail without the two roles', () => {
  const T = rd('supabase/functions/invite-mailer/templates.ts');
  assert.doesNotMatch(T, /coordinator|designer/i); assert.match(T, /crew: "Crew"/);
  const E = rd('supabase/functions/comms-dispatch/staff-email.mjs');
  assert.match(E, /const ESC_WHO = \["the event lead is told", "the event lead and the manager are told", "the event lead, the manager and the admin \/ owner are told"\];/);
  assert.doesNotMatch(E + rd('supabase/functions/comms-dispatch/helm-notices.mjs'), /coordinator|designer/i);
});

const SQL = rd('supabase/migrations/0400_r232_remove_role_traces.sql'), APPLY = rd('supabase/APPLY-0400.sql');
t('4a 0400: safety gate first, copies before every delete / change, deletes only the three trace tables', () => {
  assert.ok(!/[^\x00-\x7F]/.test(SQL) && !/[^\x00-\x7F]/.test(APPLY), 'ASCII only');
  for (const s of [SQL, APPLY]) assert.doesNotMatch(s, /create temp|set session|\bset local\b|set_config\(/i, 'no temp tables / session state');
  const body = SQL.slice(SQL.indexOf('do $r400$'));
  assert.ok(body.indexOf('if exists (select 1 from public._r400_blockers()) then') < body.indexOf('delete from'), 'gate before any delete');
  const dels = [...SQL.matchAll(/\bdelete from (public\.\w+)/gi)].map((m) => m[1]);
  assert.deepEqual([...new Set(dels)].sort(), ['public.invitations', 'public.notification_prefs', 'public.role_access']);
  for (const tb of ['role_access', 'invitations', 'notification_prefs']) {
    assert.ok(SQL.indexOf("'r400_" + tb + "'") > 0 && SQL.indexOf("'r400_" + tb + "'") < SQL.indexOf('delete from public.' + tb), tb + ': copy first');
  }
  assert.ok(SQL.indexOf("'r400_invite_email_outbox'") < SQL.indexOf('delete from public.invitations'), 'invite e-mail rows copied first');
  assert.doesNotMatch(SQL, /\bdrop table\b|\btruncate\b|delete from (auth\.|public\.(profiles|quotes|event_tasks|quote_payments|chat_|notifications|audit_log))/i);
  for (const u of ['signin_notice_settings', 'event_ready_alert_settings', 'comms_settings', 'vendor_bill_settings', 'crew_members', 'helm_trial_seed_manifest', 'task_escalation_steps']) {
    const c = SQL.indexOf("'r400_" + u + "'"), w = SQL.indexOf('update public.' + u);
    assert.ok(c > 0 && w > 0 && c < w, u + ': copy before the change');
  }
  assert.match(SQL, /if coalesce\(current_setting\('helm\.r400_remove', true\), ''\) = 'off' then/);
  // Crew available again: the 0398 guard list = the two removed roles only, old body kept
  assert.match(SQL, /select array\['coordinator', 'designer'\]::text\[\];\n\$b\$ \$f\$;/);
  assert.match(SQL, /perform public\._r400_keep\('public\._r398_retired_roles\(\)'::regprocedure\);/);
  // constraints NOT VALID + VALIDATE
  assert.equal((SQL.match(/ not valid;/g) || []).length, (SQL.match(/ validate constraint /g) || []).length);
});

t('4b APPLY-0400 = header + migration verbatim + 15 check rows in one transaction; registered everywhere', () => {
  assert.ok(APPLY.includes(SQL), 'migration verbatim');
  assert.match(APPLY, /^begin;$/m); assert.match(APPLY, /\) v\(item, ok\) order by item;\ncommit;\n$/);
  for (let i = 1; i <= 15; i++) assert.match(APPLY, new RegExp("'" + String(i).padStart(2, '0') + ' '), 'check ' + i);
  assert.match(APPLY, /'01 STOP - run DELETE-0398 first: '/);
  assert.match(rd('supabase/migrations/MANIFEST'), /\nforward {2}supabase\/migrations\/0400_r232_remove_role_traces\.sql\n/);
  const RUN = rd('scripts/db-test/run-all.sh');
  assert.match(RUN, /-c helm\.r400_remove=off"/);
  assert.match(RUN, /run "r232-remove-role-traces-0400" "R232-REMOVE-ROLE-TRACES-0400: PASS" bash tests\/db\/r232-remove-role-traces-0400\.sh\n\necho "-{10,}"/);
  assert.match(rd('tests/db/r232-remove-role-traces-0400.sh'), /R232-REMOVE-ROLE-TRACES-0400: PASS/);
  assert.match(rd('supabase/check-prod-overrides.json'), /"0400": \{/);
  for (const f of ['test/release-1019.test.mjs', 'test/release-1020.test.mjs']) assert.match(rd(f), /'0399', '0400'(, '0\d{3}')*\]/, f);
});

console.log(process.exitCode ? 'R232 tests FAILED' : `R232 tests: ${n}/${n} ok`);
