// R92 Ops: Live status filter + mobile/tablet CSS + locked Reassign + task lifecycle migration 0311.
//   1 filter bar markup + re-applied after every renderDashboard (incl. the no-tasks early return)
//   2 filter behaviour (run in a vm): search / person / section / status / QC pending; rows + empty groups hidden by
//     class, group counts updated, per-event localStorage (broken storage tolerated), Clear restores
//   3 locked Reassign (accepted / in progress / completed) + QC buttons only for completed + pending
//   4 no inline style on the suggestion buttons; CSS: pointer:coarse 44px + 16px inputs, tablet block, crew-shifts, work.html
//   5 work.html / runsheet: no Reject / Accept once answered; refused answers shown as-is (store-api taskAnswer)
//   6 migration 0311 + APPLY + MANIFEST + run-all + page tour
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = async (name, fn) => { try { await fn(); n++; } catch (e) { console.error('FAIL ' + name); throw e; } };
const ops = read('public/ops.html'), work = read('public/work.html'), rs = read('public/runsheet.html'), api = read('public/store-api.js');

// R192: the filter bar (four drop-downs) became quick filter chips with counts + one search box (ops-board.js); the rule for each
// chip runs here in a vm against the same shared status module (task-status.js) the page and /monitor use
const W = {}; const CTX = { window: W, Intl, Date, Math, Number, String, Object, Array, JSON, isFinite, isNaN, Infinity, Promise, setInterval() {}, clearInterval() {} };
vm.runInNewContext(read('public/task-status.js'), CTX); vm.runInNewContext(read('public/ops-board.js'), CTX);
const PURE = W.OpsBoard._pure;
await t('1 quick filter chips + search replace the drop-downs', async () => {
  for (const id of ['opsFilter', 'of_q', 'of_person', 'of_section', 'of_status']) assert.ok(!ops.includes(`id="${id}"`), id + ' gone');
  assert.match(ops, /<div class="tc-chips" id="chips" role="group" aria-label="Quick filters"><\/div>/);
  assert.match(ops, /<input id="tcQ" type="search" maxlength="80" placeholder="Search tasks or people"/);
  assert.deepEqual(JSON.parse(JSON.stringify(PURE.CHIPS.map((c) => c[1]))), ['All', 'Late', 'Special', 'No one yet', 'Waiting for a yes', 'No time', 'QC to check', 'Can’t-work clash', 'Done', 'Cancelled']);
});
await t('2 chip rules', async () => {
  const now = Date.parse('2026-11-21T10:00:00Z'), past = '2026-11-21T09:00:00Z', later = '2026-11-21T12:00:00Z';
  const tk = [
    { id: '1', status: 'completed', verify_status: 'pending', planned_start: past, crew_id: 'a' },
    { id: '2', status: 'accepted', planned_start: past, crew_id: 'a', is_special: true },
    { id: '3', status: 'unassigned', crew_id: 'c', assignee_name: 'Asha', planned_start: later },
    { id: '4', status: 'rejected', assignee_name: 'Ravi' },
    { id: '5', status: 'unassigned' },
    { id: '6', status: 'cancelled', planned_start: past, crew_id: 'a' },
  ];
  const ids = (k, clash) => tk.filter((x) => PURE.chipTest(k, x, now, clash)).map((x) => x.id).join(',');
  assert.equal(ids(''), '1,2,3,4,5', 'All leaves cancelled out');
  assert.equal(ids('late'), '2'); assert.equal(ids('special'), '2');
  assert.equal(ids('none'), '4,5', 'no one yet = nobody or turned down');
  assert.equal(ids('wait'), '3', 'an "unassigned" row that names someone is waiting for a yes (r20)');
  assert.equal(ids('notime'), '4,5'); assert.equal(ids('qc'), '1'); assert.equal(ids('done'), '1'); assert.equal(ids('cancelled'), '6');
  assert.equal(ids('clash', (x) => x.id === '2' || x.id === '1'), '2', 'a done task never counts as a clash');
});
await t('3 Reassign only before the person said yes + QC buttons only for completed + pending', async () => {
  const B = read('public/ops-board.js');
  assert.match(B, /if \(t\.status === "assigned" && !noOne\(t\)\) foot\.push\(h\("button", \{ type: "button", cls: "tc-btn", "data-key": "a:re", text: "Reassign"/);
  assert.match(B, /Accepted tasks stay with their person - to move one, cancel it \(a reason is required\) and give it out again\./);
  assert.match(B, /var REASSIGNABLE = \["unassigned", "assigned", "rejected"\];/);
  assert.match(ops, /filter\(t=>t&&\["unassigned","assigned","rejected"\]\.includes\(t\.status\)\)/);   // the sheet re-checks before reassign_task
  assert.match(B, /g\.canVerify && t\.status === "completed" && t\.verify_status === "pending"/);
});

await t('4 CSS + no inline style on suggestions', async () => {
  const sugg = ops.slice(ops.indexOf('async function renderSuggestions'), ops.indexOf('async function refresh('));
  assert.ok(!/style=/.test(sugg), 'no style= in renderSuggestions');
  // R192: suggestions rank the sheet's person list (free / booked elsewhere / asked off / day off, star = department match)
  assert.match(sugg, /sugg=\{\}; \(list\|\|\[\]\)\.forEach\(s=>\{ if\(s&&s\.id\) sugg\[s\.id\]=s; \}\);/);
  assert.match(read('public/ops-board.js'), /text: x\.pending \? "asked off" : "day off"/);
  assert.match(ops, /\.sugg\{margin:0 6px 6px 0\} \.sugg\.busy\{opacity:\.6\}/);
  const coarse = ops.slice(ops.indexOf('@media (pointer:coarse)'));
  assert.match(coarse, /\.btn,\.btn\.sm,\.account button,\.tabs button\{min-height:44px/);
  assert.match(coarse, /\.titem\{min-height:44px\}/); assert.match(coarse, /input,select\{min-height:44px;font-size:16px\}/);
  assert.match(ops, /@media \(min-width:641px\) and \(max-width:1024px\)\{\s*\.crewrow\{grid-template-columns:minmax\(0,1fr\) minmax\(0,1fr\)\}\s*\.tasklist\{max-height:none\}\s*\.trow \.cat\{[^}]*overflow-wrap:anywhere/);
  assert.match(read('public/crew-shifts.css'), /@media \(pointer:coarse\)\{\.cs-cell\{width:40px;height:40px[^}]*\}\.cs-form input,\.cs-form select,\.cs-edit input\{height:44px/);
  assert.match(work, /\.btn\{height:48px\}/); assert.match(work, /\.eq \.btn\{height:44px\}/); assert.match(work, /\.thumbs button\{width:36px;height:36px/);
  assert.match(work, /@media \(min-width:768px\)\{\s*\.wrap\{max-width:960px\}\s*#tasks\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.ok(work.includes('<div id="tasks"></div>'), 'grid container is #tasks');
});

await t('5 answers are final in the crew screens', async () => {
  assert.match(work, /if\(t\.status==='assigned'\) acts=`[^`]*data-a="reject"/, 'Reject only for assigned');
  assert.match(work, /else if\(t\.status==='accepted'\) acts=`<button type="button" class="btn primary" data-a="start">Start task<\/button>`;/, 'accepted: no Reject');
  assert.ok(!/rejected:\[\["accept"/.test(rs), 'run-sheet: no Accept after a rejection');
  assert.match(api, /function taskAnswer\(r\) \{\s*if \(r && r\.ok === false && r\.refused\)/);
  assert.equal((api.match(/\.then\(taskAnswer\)/g) || []).length, 3, 'worker respond, evidence, crew respond');
  assert.ok(work.includes('e&&e.refused ? e.message'), 'work.html shows the refusal'); assert.ok(rs.includes('e&&e.refused ? e.message'));
});

await t('6 migration 0311 / APPLY / MANIFEST / run-all / tour', async () => {
  const m = read('supabase/migrations/0311_r92_task_lifecycle.sql'), a = read('supabase/APPLY-0311.sql'), man = read('supabase/migrations/MANIFEST');
  assert.ok(!/[^\x00-\x7f]/.test(m) && !/[^\x00-\x7f]/.test(a), 'ASCII only');
  assert.ok(a.includes(m), 'APPLY carries the migration body'); assert.match(a, /^begin;$/m); assert.match(a, /^commit;$/m); assert.match(a, /-- VERIFY/);
  assert.match(m, /raise exception 'STOP 0311/);
  assert.ok(man.includes('forward  supabase/migrations/0311_r92_task_lifecycle.sql'));
  assert.ok(!/\b(drop table|delete from|truncate|drop column|drop function)\b/i.test(m), 'nothing dropped / deleted');
  assert.match(m, /create trigger zzzz_r311_task_flow before update on public\.event_tasks/);
  for (const mv of ['unassigned>assigned', 'assigned>accepted', 'rejected>assigned', 'accepted>completed', 'completed>in_progress']) assert.ok(m.includes(`'${mv}'`), mv);
  assert.ok(!m.includes("'accepted>rejected'") && !m.includes("'rejected>accepted'"), 'owner 2a: answers are final');
  assert.match(m, /__pre0311\(%s\)', r\.fn, r\.args\)\) is null then/, 'wrap once');
  assert.ok(read('scripts/db-test/run-all.sh').includes('tests/db/r92-task-lifecycle-0311.sql'));
  assert.ok(read('public/page-tours.js').includes('sel: ["#chips", "#tcQ"]'));   // R192: chips + search
});

console.log(`r92-ops-lifecycle: ${n}/6 passed`);
