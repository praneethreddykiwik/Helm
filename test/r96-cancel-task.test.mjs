// R96 Cancel task: Ops Cancel button + reason modal, store-api cancel -> rpc cancel_task, cancelled rows greyed with the
// reason, crew link / runsheet show "Cancelled by the office" with no actions, page tour, migration 0312 wiring.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = async (name, fn) => { try { await fn(); n++; } catch (e) { console.error('FAIL ' + name); throw e; } };
const ops = read('public/ops.html'), work = read('public/work.html'), rs = read('public/runsheet.html'), api = read('public/store-api.js');

// R192: the row has no buttons any more - Cancel lives in the task panel (ops-board.js) and in the bulk bar
const B = read('public/ops-board.js');
await t('1 Cancel only for Staff editors on assigned / accepted / in_progress', async () => {
  assert.match(B, /var CANCELLABLE = \["assigned", "accepted", "in_progress"\];/);
  assert.match(ops, /const CANCELLABLE=\['assigned','accepted','in_progress'\];/);
  assert.match(B, /if \(CANCELLABLE\.indexOf\(t\.status\) >= 0\) foot\.push\(h\("button", \{ type: "button", cls: "tc-btn danger push", "data-key": "a:cancel", text: "Cancel task", on: \{ click: function \(\) \{ P\(\)\.cancel\(t\.id\); \} \} \}\)\);/);
  // every action button in the panel sits inside if (edit) { ... } - view-only roles see "View only" instead
  assert.match(B, /\} else if \(!foot\.length\) foot\.push\(h\("span", \{ cls: "tc-viewonly", text: "View only" \}\)\);/);
  // bulk Cancel: only the cancellable ones, a reason of 3-300 characters
  assert.match(B, /var can = ts\.filter\(function \(t\) \{ return CANCELLABLE\.indexOf\(t\.status\) >= 0; \}\);/);
  assert.match(B, /if \(reason\.length < 3 \|\| reason\.length > 300\)/);
});
await t('2 cancelled tasks are kept, greyed, with the reason as text (never markup)', async () => {
  assert.match(B, /\(t\.status === "cancelled" \? " is-cancelled" : ""\)/);
  assert.match(B, /text: "Cancelled" \+ \(t\.cancel_reason \? ": " \+ t\.cancel_reason : ""\)/);
  assert.match(read('public/ops-board.css'), /\.tc-row\.is-cancelled \.tc-r-title b\{text-decoration:line-through/);
  assert.match(read('public/task-status.js'), /cancelled: "Cancelled"/);
  assert.doesNotMatch(B, /innerHTML|insertAdjacentHTML/);
});
await t('3 modal: reason required 3-300, calls BPStore.ops.cancel, Ops filter keeps cancelled', async () => {
  for (const id of ['cancelTaskModal', 'cancelTaskForm', 'ct_task', 'ct_reason', 'ct_err', 'ct_back', 'ct_save']) assert.ok(ops.includes(`id="${id}"`), id);
  assert.match(ops, /<textarea id="ct_reason" required minlength="3" maxlength="300"/);
  assert.match(ops, /reason\.length<3/); assert.match(ops, /reason\.length>300/);
  assert.match(ops, /await BPStore\.ops\.cancel\(ctTaskId,reason\)/);
  assert.match(ops, /cancel:\(id\)=>openCancelTask\(id\)/);
  // R192: the one 30 s refresh skips while any pop-up (.lmodal) is open
  assert.match(B, /function busyElsewhere\(\) \{ return Array\.prototype\.some\.call\(doc\.querySelectorAll\("\.lmodal"\), function \(m\) \{ return !m\.hidden; \}\)/);
  assert.match(B, /\["done", "Done"\], \["cancelled", "Cancelled"\]/, 'Cancelled chip');
  const modal = ops.slice(ops.indexOf('id="cancelTaskModal"'), ops.indexOf('id="schedModal"'));
  assert.doesNotMatch(modal, /style=/, 'no inline style (CSP)');
});
await t('4 store-api cancel -> rpc cancel_task', async () => {
  assert.match(api, /cancel: \(taskId, reason\) => rpc\("cancel_task", \{ p_task: taskId, p_reason: String\(reason \|\| ""\)\.trim\(\) \}\)/);
});
await t('5 crew link + runsheet: "Cancelled by the office", no actions', async () => {
  assert.match(work, /LABEL=\{[^}]*cancelled:"Cancelled"/);
  assert.match(work, /else if\(t\.status==='cancelled'\) acts=`<span class="cxl">Cancelled by the office<\/span>`;/);
  assert.match(rs, /t\.status==="cancelled"\?"Cancelled by the office"/);
  assert.doesNotMatch(rs.match(/const TASK_ACTS=\{[^\n]*\};/)[0], /cancelled/);
});
await t('6 page tour + migration 0312 wiring', async () => {
  assert.match(read('public/page-tours.js'), /use Cancel \(a reason is required\)/);
  const mig = read('supabase/migrations/0312_r96_cancel_task.sql');
  assert.match(read('supabase/migrations/MANIFEST'), /^forward  supabase\/migrations\/0312_r96_cancel_task\.sql$/m);
  assert.match(mig, /create or replace function public\.cancel_task\(p_task uuid, p_reason text\)/);
  assert.match(mig, /has_area\('staff', 'edit'\)/); assert.match(mig, /for update;/);
  assert.match(mig, /grant execute on function public\.cancel_task\(uuid, text\) to authenticated/);
  assert.doesNotMatch(mig, /\b(drop table|drop column|delete from|truncate)\b/i);
  assert.ok(/^[\x00-\x7f]*$/.test(mig), 'ASCII');
  const ap = read('supabase/APPLY-0312.sql');
  assert.ok(ap.includes(mig.replace(/\s*$/, '\n')), 'APPLY carries the migration verbatim');
  assert.match(ap, /^begin;$/m); assert.match(ap, /^commit;$/m); assert.match(ap, /-- VERIFY/);
  assert.match(read('scripts/db-test/run-all.sh'), /r96-cancel-task-0312/);
});
console.log(`r96-cancel-task: ${n} passed`);
