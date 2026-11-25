// R230: Tasks & Crew is direct again - Tasks by department first (each department card: tasks with person / time / status,
// Email / WhatsApp, + Add task, Supervisor), the four event steps below; one supervisor per event + department (0399).
//   1 page order + wording (ops.html), the steps kept whole and quieter, default view = by department
//   2 ops-board.js: supervisor picker only with 0399 + "Assign & send tasks", name for view-only, "You supervise", quick links
//   3 monitor: "My departments" filter; store-api calls null before 0399
//   4 safety: 0399 additive (no drop table / delete / truncate), ASCII, guards, APPLY checks, MANIFEST, run-all, release lists,
//     tours <= 8 steps, theme tokens only in the new CSS
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); } };
const OPS = read('public/ops.html'), BRD = read('public/ops-board.js'), CSS = read('public/ops-board.css'), MON = read('public/monitor.js');
const STORE = read('public/store-api.js'), TOURS = read('public/page-tours.js'), SQL = read('supabase/migrations/0399_r230_dept_supervisors.sql');
const APPLY = read('supabase/APPLY-0399.sql'), MAN = read('supabase/migrations/MANIFEST'), RUNALL = read('scripts/db-test/run-all.sh');
const DBT = read('tests/db/r230-dept-supervisors-0399.sql'), OVR = read('supabase/check-prod-overrides.json');

await t('1a page order (R251): event header -> the three steps -> the step cards with Tasks by department among them -> Wrap-up last', () => {
  const iHead = OPS.indexOf('id="evhead"'), iWork = OPS.indexOf('id="work"'), iSteps = OPS.indexOf('id="tcSteps"'), iPhase = OPS.indexOf('id="tcPhase"');
  assert.ok(iHead > 0 && iHead < iSteps && iSteps < iPhase && iPhase < iWork, 'order');
  for (const id of ['tcPrep', 'tcDayBefore', 'tcReady', 'tcRun', 'attn', 'tcIssues', 'tcWrap']) {
    const i = OPS.indexOf('id="' + id + '"'); assert.ok(i > iSteps, id + ' sits inside the steps section');
  }
  assert.match(OPS, />Tasks by department </);
  assert.match(OPS, /data-view="list" aria-pressed="true">By department</);
  for (const w of ['Day before', 'Pre-event', 'On the event']) assert.ok(OPS.includes('>' + w + '</button>'), w);
});
await t('1b the page opens on By department (new saved-view key, so an old Timeline pick does not hide it)', () => {
  assert.match(BRD, /lsGet\("helm\.tc\.view2"\)/); assert.match(BRD, /lsSet\("helm\.tc\.view2", v\)/);
});
await t('2a supervisor UI only when 0399 answered (S.sup null -> nothing), picker only with Assign & send tasks, role beside the name', () => {
  assert.match(BRD, /function supTools\(cat\) \{[\s\S]*?if \(!S\.sup\) return wrap;/);
  assert.match(BRD, /if \(S\.sup\.can_edit\) \{/);
  assert.match(BRD, /supervisor: "Supervisor", manager: "Event manager", admin: "Admin"/);
  assert.match(BRD, /"No supervisor"/);
  assert.match(BRD, /loadSup\(false\)/);
  assert.match(STORE, /deptSupervisors: \{[\s\S]*?if \(rpcMissing\(e\)\) return null;/);
  assert.match(STORE, /rpc\("event_department_supervisor_set", \{ p_quote: quoteId, p_department: String\(department \|\| ""\), p_profile: profileId \|\| null \}\)/);
});
await t('2b each department card: + Add task (opens Add & assign on that section), "You supervise", rows with Email / WhatsApp / Assign', () => {
  assert.match(BRD, /: "\+ Add task"/); assert.match(BRD, /function addIn\(cat\)/);
  assert.match(BRD, /#catTabs \[data-c\]/);
  assert.match(BRD, /"You supervise: "/);
  assert.match(BRD, /text: "Email"[\s\S]{0,200}P\(\)\.mail\(e\.currentTarget, t\.id, false\)/);
  assert.match(BRD, /text: "WhatsApp"[\s\S]{0,200}P\(\)\.wa\(e\.currentTarget, t\.id\)/);
  assert.match(BRD, /text: "Assign"/);
  assert.match(BRD, /"No tasks yet:"/);
});
await t('2d R257: no plan lock; a closed event takes no new tasks; the supervisor picker stays', () => {
  assert.match(BRD, /function addIn\(cat\) \{[\s\S]{0,200}if \(planClosed\(\)\) \{ toast\(LOCK_ADD, "err", 8000\); return; \}/);
  assert.match(BRD, /var LOCK_ADD = "This event is closed, so no new tasks\."/);
  assert.doesNotMatch(BRD.slice(BRD.indexOf('async function setSup'), BRD.indexOf('function supTools')), /planClosed/);
  assert.ok(!/tcLockIn/.test(OPS) && OPS.indexOf('id="tcFloor"') > OPS.indexOf('id="tcSteps"'), 'no Lock plan; floor card in the steps');
});
await t('2c the supervisor history shows in Latest ("X set Y as Catering supervisor")', () => {
  assert.match(BRD, /" as " \+ l\.department \+ " supervisor"/); assert.match(BRD, /concat\(supLogActs\(\)\)/);
});
await t('3 monitor: "My departments" filter from the supervisors of the shown events', () => {
  assert.match(MON, /opt\("__mine", "My departments \("/);
  assert.match(MON, /if \(sec === "__mine"\)/);
  assert.match(MON, /loadMine\(ids\)/);
});
await t('4a 0399 is additive: no drop table / delete from / truncate / alter ... drop; ASCII only; guards + empty search_path', () => {
  assert.doesNotMatch(SQL, /drop\s+table|delete\s+from|truncate|alter\s+table[^;]*drop/i);
  assert.ok(!/[^\x00-\x7F]/.test(SQL) && !/[^\x00-\x7F]/.test(APPLY), 'ASCII');
  assert.doesNotMatch(APPLY, /create\s+temp|set\s+local|set\s+session/i, 'paste-safe');
  assert.match(SQL, /_r385_can_assign\(\)/); assert.match(SQL, /tg_quote_org_match/); assert.match(SQL, /unique \(quote_id, department\)/);
  assert.match(SQL, /for each row when \(new\.kind = 'task_escalated'\)/);
  const defs = SQL.match(/create or replace function[\s\S]*?\$fn\$;?/g) || [];
  assert.equal(defs.length, 6);
  for (const d of defs) assert.match(d, /security definer set search_path = ''/);
});
await t('4b APPLY-0399 = the migration + 12 checks in one transaction; MANIFEST, run-all, overrides, release lists know 0399', () => {
  assert.ok(APPLY.includes(SQL.trim().split('\n').slice(0, 5).join('\n')));
  assert.match(APPLY, /^begin;$/m); assert.match(APPLY, /^commit;$/m);
  assert.equal((APPLY.match(/^  \('\d\d /gm) || []).length, 12);
  assert.match(MAN, /^forward  supabase\/migrations\/0399_r230_dept_supervisors\.sql$/m);
  assert.match(RUNALL, /R230-DEPT-SUPERVISORS-0399: ALL PASS \\\(25\/25\\\)/);
  assert.match(DBT, /R230-DEPT-SUPERVISORS-0399: ALL PASS/);
  assert.match(OVR, /"0399":/);
  for (const f of ['test/release-1019.test.mjs', 'test/release-1020.test.mjs']) assert.match(read(f), /'0398', '0399'(, '0\d{3}')*\]/);
});
await t('4c the tour of Tasks & Crew has at most 8 steps and names departments + supervisor; new CSS uses theme tokens only', () => {
  const i = TOURS.indexOf('"ops.html": ['), j = TOURS.indexOf('\n    ],', i);
  const steps = (TOURS.slice(i, j).match(/\{ sel:/g) || []).length;
  assert.ok(steps >= 5 && steps <= 8, 'steps ' + steps);
  assert.match(TOURS.slice(i, j), /Tasks by department/); assert.match(TOURS.slice(i, j), /Supervisor/);
  const r230 = CSS.slice(CSS.indexOf('/* R230:'));
  assert.ok(r230.length > 200);
  assert.doesNotMatch(r230, /#[0-9a-f]{3,6}\b/i, 'no hard-coded colours');
});

console.log(`\nR230 department supervisors: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
