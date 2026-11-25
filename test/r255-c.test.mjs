// R255 (owner's live test, 25 Nov 2026): Add & assign order and calm defaults, deactivated logins, check-in first, extras, the work page bar,
// the staff form stars and SQL 0440. Pure rules + the wiring; the presses run in a browser with stub data, the SQL in tests/db.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const read = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const OPS = read('public/ops.html'), BRD = read('public/ops-board.js'), API = read('public/store-api.js'), WRAP = read('public/event-wrap.js'), XT = read('public/event-extras.js'), STEPS = read('public/event-steps.js'), WORK = read('public/work.html'), STAFF = read('public/staff.html'), SQL = read('supabase/migrations/0440_r255_tasks_crew.sql');

test('the sheet: task, step, person, waits for, start time (No time yet), reminders (only with a time), tell them', () => {
  const s = OPS.slice(OPS.indexOf('id="sheet"')), at = (x) => { const i = s.indexOf(x); assert.ok(i > 0, x); return i; };
  const order = ['id="sWhat"', 'id="sStep"', 'id="sWho"', 'id="sDep"', 'id="assignTime"', 'id="sRem" hidden', 'Tell them</legend>'].map(at); assert.deepEqual(order, order.slice().sort((a, b) => a - b));
  assert.match(OPS, /let asDay="none"/); assert.match(OPS, /id="as_none" data-day="none" aria-pressed="true"/); assert.match(OPS, /sheetOpened:[^\n]*asRem=null; asDay="none"; \$\("#as_when"\)\.value="";/);
  assert.match(OPS, /\$\("#sRem"\)\.hidden=!on\|\|/); assert.match(OPS, /role="switch" id="as_remOn"/); assert.match(OPS, /if\(asRem && !\$\("#as_remOn"\)\.checked && trmSettings && trmSettings\.enabled!==false\)\{ mins=\[\]; at=\[\]; \}/);
  // the saving calls are what they were
  for (const c of ['BPStore.ops.assignTasks(quoteId, activeCat, titles, c.id, c.name, c.phone, stepOpt())', 'BPStore.ops.setSchedule(x.id, when?when.start:(x.planned_start||null), null, depFor(x,mine))', 'if(when.mins!==undefined && trmSettings) await BPStore.ops.setReminders(x.id, when.mins);', 'if(when||special||dep||order){']) assert.ok(OPS.includes(c), c);
});
test('picking a person folds the list, keeps the focus on Change, scrolls calmly; the footer says no time = no reminders', () => {
  assert.match(BRD, /S\.pickOpen = false; sel\.dispatchEvent/); assert.match(BRD, /behavior: calm\(\) \? "auto" : "smooth"/); assert.match(BRD, /prefers-reduced-motion: reduce/); assert.match(BRD, /b\.focus\(\{ preventScroll: true \}\)/);
  assert.match(BRD, /No start time - no reminders/); assert.match(BRD, /You can add a time later\./); assert.match(BRD, /i\[3\] === "notime" \|\|/, 'no start time is not something to fix any more');
});
test('change time: in the row and beside the start, until done; done and a locked plan say why', () => {
  assert.match(BRD, /"data-key": "time:" \+ t\.id/); assert.match(BRD, /"data-key": "a:start"/); assert.match(BRD, /This task is done, so its start time stays as it was\./); assert.match(BRD, /if \(planClosed\(\)\) \{ toast\(LOCK_TIME/);
  assert.equal((BRD.match(/P\(\)\.schedule\(t\.id\)/g) || []).length, 2, 'changeTime + Waits for');
});
test('a deactivated login: in no picker, said on the task it holds, refused by the database; before 0440 the directory tells', () => {
  assert.match(API, /supa\.rpc\("crew_login_off"\)/); assert.match(API, /if \(!rpcMissing\(r\.error\)\) return out;/); assert.match(API, /\(deactivated\\\)\$/); assert.match(API, /markLoginOff\(s, off\)\.filter\(\(p\) => !p\.login_off\)/);
  assert.match(BRD, /\(g\.crew \|\| \[\]\)\.filter\(function \(c\) \{ return !c\.login_off; \}\)/); assert.equal((OPS.match(/crew\.filter\(c=>!c\.login_off\)\.map\(crewOption\)/g) || []).length, 2);
  assert.match(read('public/day-before.js'), /!c\.login_off/); assert.match(read('public/issue-assign.js'), /c\.login_off/); assert.match(OPS, /r440_login_off/);
  assert.match(SQL, /case when c\.profile_id is not null then public\._r283_is_off\(c\.profile_id, p_org\) else public\._r283_off_email\(p_org, c\.email\) end/);
});
test('each step opens with its own card', () => {
  const o = (w) => JSON.parse('[' + BRD.match(new RegExp('\\n    ' + w + ': \\[([^\\]]+)\\]'))[1] + ']');
  assert.equal(o('daybefore')[0], 'tcDayBefore'); assert.deepEqual(o('pre').slice(0, 2), ['tcPreList', 'tcCheckin']); assert.equal(o('onday')[0], 'tcRun'); const d = o('onday'); assert.equal(d.indexOf('tcExtras'), d.indexOf('tcIssues') + 1);
  assert.match(BRD, /"data-key": "run:build", href: "runsheet\.html\?quote=/);
});
test('check-in strip: not in first, a button only for who works today and may sign in', () => {
  const W = require('../public/event-wrap.js')._pure, ts = { rows: [{ crew_id: 'a', name: 'Asha', entries: [{ day: '2026-11-26', in: '07:40' }] }, { crew_id: 'b', name: 'Bala', entries: [] }, { crew_id: 'c', name: 'Chitra', entries: [] }] };
  const r = W.stripRows(ts, () => true, (id) => id === 'c'); assert.deepEqual(r.map((x) => [x.id, x.state, x.due]), [['b', 'none', true], ['c', 'none', false], ['a', 'in', false]]);
  assert.deepEqual(W.stripRows({ rows: [] }, () => true), []); assert.match(WRAP, /office\(env, r, "in"\)/, 'the same office check-in as Wrap-up');
});
test('extras: a list only', () => {
  const X = require('../public/event-extras.js')._pure;
  assert.deepEqual(X.readForm({ what: '  20  plates ', qty: '20', cost: '4,500' }).item, { what: '20 plates', qty: '20', cost: '4500', asked_by: null, approved_by: null, note: null });
  assert.equal(X.readForm({ what: ' ' }).field, 'what'); for (const q of ['0', '-1', 'abc', '1e5']) assert.equal(X.readForm({ what: 'x', qty: q }).field, 'qty', q); assert.equal(X.readForm({ what: 'x', cost: 'abc' }).field, 'cost'); assert.equal(X.readForm({ what: 'x'.repeat(201) }).field, 'what');
  assert.equal(X.title({ what: 'Table', qty: 1 }), 'Table'); assert.equal(X.title({ what: 'Plates', qty: '20.00' }), 'Plates × 20'); assert.deepEqual(X.split([{ id: 1 }, { id: 2, cancelled_at: 'x' }]).live.length, 1);
  assert.doesNotMatch(XT, /innerHTML|insertAdjacentHTML|\.delete\(|quotes\.|budget\.|payments|change_requests/); assert.match(API, /async list\(quoteId\) \{ if \(!supa \|\| !quoteId\) return null; try \{ return await rpc\("event_extras_list"/);
  const H = require('../public/task-status.js') && require('../public/event-steps.js'); void H; const rows = globalThis.HelmEventWrap._pure.rowsOf({ quoteId: 'q', quote: {}, tasks: [] }, { extras: { items: [{ what: 'Plates' }, { what: 'Old', cancelled_at: 'x' }] } }).filter((r) => r.id === 'extras');
  assert.equal(rows[0].status, '1 to decide'); assert.match(rows[0].text, /the bill does not change by itself/); assert.equal(globalThis.HelmEventWrap._pure.rowsOf({ quoteId: 'q', quote: {}, tasks: [] }, { extras: null }).some((r) => r.id === 'extras'), false, 'no 0440 = no row');
  assert.match(STEPS, /not part of the progress/); assert.doesNotMatch(SQL, /insert into public\.(change_requests|event_costs|quote_payments)|update public\.(quotes|change_requests|event_costs)/);
});
test('work page: cancelled and turned-down work does not count, the bar fills', () => {
  assert.match(WORK, /\.prog \.fill\{display:block;height:100%/, 'a span with a height needs display:block'); assert.match(WORK, /mine=all\.filter\(t=>t\.status!=='cancelled'&&t\.status!=='rejected'\)/); assert.match(WORK, /role="progressbar"/);
});
test('staff form: a star on every required field, the message under the field', () => {
  assert.match(STAFF, /for="s_dept">Department <span class="req" id="s_dept_req" aria-hidden="true">\*<\/span>/); assert.match(STAFF, /<select id="s_dept" aria-required="true" aria-describedby="s_dept_msg">/); assert.match(STAFF, /id="s_dept_msg" aria-live="polite"/);
  assert.match(STAFF, /nameOk=checkName\(\), deptOk=checkDept\(\), pv=checkPhone\(\)/); assert.match(STAFF, /syncDeptReq\(\); setLinkedLock\(s\)/);
});
test('0440: additive, pinned search_path, no session state, the old bodies kept, a read-only check at the end', () => {
  assert.doesNotMatch(SQL, /create temp|set session|delete from|drop table|drop column|truncate/i); for (const m of SQL.matchAll(/create or replace function public\.[^$]+?\$/g)) assert.match(m[0], /set search_path = ''/, m[0].slice(0, 80));
  assert.match(SQL, /when u\.not_before <= now\(\) then u\.not_before/); assert.match(SQL, /accepted for you by the office/); assert.match(SQL, /perform public\._r410_wake\('comms-dispatch'\); exception when others then null;/); assert.match(SQL, /revoke all on table public\.event_extras/);
  assert.match(SQL.trim(), /\) c\("check", ok\);$/); assert.ok(/^[\x00-\x7f]*$/.test(SQL)); assert.ok(read('supabase/APPLY-0440.sql').includes(SQL.trimEnd())); assert.match(read('supabase/migrations/MANIFEST'), /forward  supabase\/migrations\/0440_r255_tasks_crew\.sql/);
});
