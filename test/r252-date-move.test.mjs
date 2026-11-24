// R252: the event date changed -> task times move with it, after asking (event-date-move.js)
import assert from 'node:assert/strict'; import vm from 'node:vm'; import { readFileSync } from 'node:fs';
const r = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8'); let pass = 0, fail = 0;
const t = async (n, f) => { try { await f(); pass++; console.log('  ok  ' + n); } catch (e) { fail++; console.log('  FAIL ' + n + '\n       ' + e.message); } };
const W = {}; const G = { window: W, Intl, Date, Math, isNaN, isFinite, Array, String, Number, Object, Promise };
vm.runInNewContext(r('public/studio-time.js'), G); vm.runInNewContext(r('public/event-date-move.js'), G); const M = W.HelmDateMove;
const T = (o) => Object.assign({ id: 'a', title: 'Stage', status: 'assigned', planned_start: '2026-11-29T02:30:00Z', planned_end: null, depends_on: null }, o);
await t('1 same wall clock on the new day; end, exact reminders and Waits for kept', () => {
  const p = M.plan([T({ planned_end: '2026-11-29T05:30:00Z', depends_on: 'z', remind_at: ['2026-11-29T02:00:00Z'] })], '2026-11-29', '2026-12-02', 'Asia/Kolkata');
  assert.equal(p.days, 3); const x = p.rows[0]; assert.deepEqual([x.start, x.end, x.depends, x.remindAt[0]], ['2026-12-02T02:30:00.000Z', '2026-12-02T05:30:00.000Z', 'z', '2026-12-02T02:00:00.000Z']);
});
await t('2 daylight saving: 8 AM stays 8 AM', () => {
  const p = M.plan([T({ planned_start: '2026-10-31T13:00:00Z' })], '2026-10-31', '2026-11-02', 'America/Chicago'); assert.equal(p.rows[0].start, '2026-11-02T14:00:00.000Z');
});
await t('3 done, cancelled, turned down and untimed tasks never move; earlier dates work; same date = nothing', () => {
  const l = ['completed', 'cancelled', 'rejected'].map((s) => T({ status: s })).concat([T({ planned_start: null })]);
  assert.equal(M.plan(l, '2026-11-29', '2026-11-30', 'Asia/Kolkata').rows.length, 0);
  // R253: started work and work sent back for rework (completed_at can still be set) move with the date
  assert.equal(M.plan([T({ status: 'in_progress', started_at: 'x' }), T({ status: 'in_progress', started_at: 'x', completed_at: 'y' })], '2026-11-29', '2026-11-30', 'Asia/Kolkata').rows.length, 2);
  assert.equal(M.plan([T()], '2026-11-29', '2026-11-28', 'Asia/Kolkata').rows[0].start, '2026-11-28T02:30:00.000Z');
  assert.equal(M.plan([T()], '2026-11-29', '2026-11-29', 'Asia/Kolkata').rows.length, 0); assert.equal(M.plan([T()], '', '2026-11-29', 'Asia/Kolkata').rows.length, 0);
});
const world = (o) => { const calls = [], said = []; W.BPStore = { studioTimezone: () => 'Asia/Kolkata', auth: { canAssignTasks: async () => o.can !== false }, ops: { listTasks: async () => { if (o.boom) throw new Error('x'); return o.tasks || [T(), T({ id: 'b' })]; },
  setSchedule: async (...a) => { calls.push(a); if (o.err) throw new Error(o.err); }, setReminderTimes: async (...a) => { calls.push(['rem'].concat(a)); }, planLock: { isLockError: (e) => /plan_locked/.test(e.message) } } };
  W.BPUI = { confirm: async (m) => { said.push(m); return o.yes !== false; }, toast: (m, x) => said.push(x.type + ':' + m) }; return { calls, said }; };
const go = () => M.ask({ quoteId: 'q', from: '2026-11-29', to: '2026-11-30' });
await t('4 asks first; No = nothing is written', async () => { const w = world({ yes: false }); const x = await go(); assert.equal(w.calls.length, 0); assert.equal(x.moved, 0); assert.match(w.said[0], /2 tasks have start times.*1 day later/); });
await t('5 Yes = one setSchedule per task', async () => { const w = world({}); const x = await go(); assert.equal(x.moved, 2); assert.deepEqual(w.calls[0], ['a', '2026-11-30T02:30:00.000Z', null, null]); assert.match(w.said[1], /ok:Moved 2 tasks 1 day later/); });
await t('6 no permission, nothing timed, failed read: no question', async () => { for (const o of [{ can: false }, { tasks: [T({ planned_start: null })] }, { boom: 1 }]) { const w = world(o); await go(); assert.equal(w.said.length, 0); assert.equal(w.calls.length, 0); } });
await t('7 a locked plan stops at once and says so; other failures are counted', async () => { let w = world({ err: 'plan_locked: x' }); let x = await go(); assert.ok(x.locked); assert.equal(w.calls.length, 1); assert.match(w.said[1], /locked/); w = world({ err: 'boom' }); x = await go(); assert.equal(x.failed, 2); assert.match(w.said[1], /Moved 0 of 2/); });
const jeq = (a, b) => assert.equal(JSON.stringify(a), JSON.stringify(b));
const S = (rows, x) => Object.assign({ can_edit: true, today: '2026-11-25', rows }, x);
const R = (x) => Object.assign({ id: 'm' + Math.random(), label: 'Final balance (20%)', status: 'due', amount: 100, remaining: 100, due_date: '2026-11-26', rule: null }, x);
await t('9 R253 payments: event rows follow, the rest by days; paid, advance, approval rows and no right = never; never before today', () => {
  const P = (rows, f, to, x) => M.planPay(S(rows, x), f, to).rows.map((r) => r.to);
  jeq(P([R()], '2026-11-26', '2026-11-30'), ['2026-11-30']);
  jeq(P([R({ due_date: '2026-11-19', rule: { anchor: 'event', offset_days: -7 } })], '2026-11-26', '2026-12-26'), ['2026-12-19']);
  jeq(P([R({ due_date: '2026-12-11', rule: { anchor: 'event', offset_days: -15 } })], '2026-12-26', '2026-11-28'), ['2026-11-25']);
  jeq(P([R({ status: 'paid' }), R({ status: 'invoiced' }), R({ remaining: 0 }), R({ label: 'Advance (30%)' }), R({ rule: { anchor: 'approval', offset_days: 0 } }), R({ due_date: null })], '2026-11-26', '2026-11-30'), []);
  jeq(P([R()], '2026-11-26', '2026-11-30', { can_edit: false }), []); assert.equal(M.planPay(null, '2026-11-26', '2026-11-30').rows.length, 0);
  jeq(P([R()], '', '2026-11-30'), []); jeq(P([R()], '2026-11-26', '2026-11-26'), []);
});
await t('10 R253 payments: asked, saved, left; a row paid while the question was open is not touched; a refusal is counted', async () => {
  const run = async (o) => { const done = [], said = []; let n = 0; const rows = [R({ id: 'a' }), R({ id: 'b', due_date: '2026-11-27' })];
    W.BPStore = { auth: { canAssignTasks: async () => false }, ops: {}, paySchedule: { forQuote: async () => { if (o.boom) throw new Error('x'); return S(++n > 1 && o.paid ? [rows[1]] : rows); } },
      milestones: { update: async (id, p) => { if (o.err) throw new Error('locked'); done.push([id, p]); } } };
    W.BPUI = { confirm: async (m) => { said.push(m); return o.yes !== false; }, toast: (m, x) => said.push(x.type + ':' + m) };
    const r = await M.ask({ quoteId: 'q', from: '2026-11-26', to: '2026-11-30' }); return { r: r.pay, done, said }; };
  let x = await run({}); jeq(x.done, [['a', { due_date: '2026-11-30' }], ['b', { due_date: '2026-12-01' }]]); assert.equal(x.r.moved, 2);
  x = await run({ yes: false }); assert.equal(x.done.length, 0); assert.match(x.said[1], /left as they are/);
  x = await run({ paid: true }); jeq(x.done.map((d) => d[0]), ['b']); assert.equal(x.r.failed, 1);
  x = await run({ err: true }); assert.equal(x.r.failed, 2); x = await run({ boom: true }); assert.equal(x.r.asked, false);
});
await t('11 R254 the same-time question: asked with the new times; No = nothing moved; not in house / no helper = not asked', async () => {
  const run = async (ans, tasks, helper = true) => { const calls = [], asked = []; W.HelmTaskClash = helper ? { ask: async (it, o) => { asked.push([it, o]); return ans; } } : undefined;
    W.BPStore = { studioTimezone: () => 'Asia/Kolkata', auth: { canAssignTasks: async () => true }, ops: { listTasks: async () => tasks, setSchedule: async (...a) => { calls.push(a); } } };
    W.BPUI = { confirm: async () => true, toast: () => {} }; const r = await M.ask({ quoteId: 'q', from: '2026-11-29', to: '2026-11-30' }); W.HelmTaskClash = undefined; return { r, calls, asked }; };
  const t1 = T({ crew_id: 'c', assignee_name: 'Ravi', duration_min: 30 });
  let x = await run(true, [t1]); assert.equal(x.calls.length, 1); assert.equal(x.asked[0][0][0].start, '2026-11-30T02:30:00.000Z'); assert.equal(x.asked[0][1].exclude.length, 1);
  x = await run(false, [t1]); assert.equal(x.calls.length, 0); assert.equal(x.r.moved, 0);
  x = await run(false, [T({ assignee_kind: 'outsourced', vendor_id: 'v', crew_id: null })]); assert.equal(x.asked.length, 0); assert.equal(x.calls.length, 1);
  x = await run(false, [t1], false); assert.equal(x.calls.length, 1);
});
await t('8 wired on the event page and the quote flow, after the save', () => { for (const p of ['event', 'flow']) { const s = r('public/' + p + '.html'); assert.match(s, /HelmDateMove\.ask\(\{ quoteId:id, from:/); assert.match(s, /event-date-move\.js\?v=\d+/); assert.ok(s.indexOf('studio-time.js') < s.indexOf('event-date-move.js')); } });
console.log(`r252-date-move: ${pass} passed, ${fail} failed`); if (fail) process.exit(1);
