// R254 (owner, 25 Nov): the step of a task is what the person picked (0438, studio setting auto_steps off by default) and R254-B: one person,
// two works at the same time - asked, never blocked. Pure rules + the wiring; the presses run in a browser with stub data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const read = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
require('../public/task-status.js'); const TS = globalThis.HelmTaskStatus; require('../public/event-plan.js'); require('../public/event-steps.js'); require('../public/event-delay.js'); require('../public/ops-board.js');
const TC = require('../public/task-clash.js'), P = TC._pure;
const API = read('public/store-api.js'), BRD = read('public/ops-board.js'), OPS = read('public/ops.html'), MON = read('public/monitor.js'), UI = read('public/task-reminders-ui.js');
const O = { eventDate: '2026-11-29', eventTime: '19:00', tz: 'Asia/Kolkata' }, at = (d, hm) => new Date(`${d}T${hm}:00+05:30`).toISOString();

test('steps: off = the pick wins over time, words, date; no pick = the old rule; on / unknown = the old rule', () => {
  const late = { title: 'DJ performance', planned_start: at('2026-11-29', '21:30'), step: 'pre' }, words = { title: 'Pack up the hall', step: 'daybefore' }, none = { title: 'DJ performance', planned_start: at('2026-11-29', '21:30'), step: null }, bad = { title: 'Stage', step: 'sometime' };
  TS.setAuto(false); assert.equal(TS.picks(), true); assert.equal(TS.taskStep(late, O), 'pre'); assert.equal(TS.taskStep(words, O), 'daybefore'); assert.equal(TS.taskStep(none, O), 'onday'); assert.equal(TS.taskStep(bad, O), 'pre'); assert.equal(TS.taskStep(late, {}), 'pre', 'no event date');
  TS.setAuto(true); assert.equal(TS.picks(), false); assert.equal(TS.taskStep(late, O), 'onday'); assert.equal(TS.taskStep(words, O), 'wrapup');
  TS.setAuto(undefined); assert.equal(TS.picks(), false, 'a database without 0438 shows no control'); assert.equal(TS.taskStep(late, O), 'onday');
  assert.equal(TS.taskStep(late, { ...O, auto: false }), 'pre', 'o.auto decides for one call'); TS.setAuto(false); assert.equal(TS.taskStep(late, { ...O, auto: true }), 'onday');
  assert.equal(TS.bySteps([late, words, none], O).pre.total, 1); TS.setAuto(undefined); assert.equal(TS.bySteps([late, words, none], O).onday.total, 2);
});
test('the setting is read in one place; without the key nothing changes; a failed read keeps what was known', async () => {
  TS.setAuto(undefined); TS.readAuto({ enabled: true }); assert.equal(TS.autoSteps(), undefined); TS.readAuto(null); assert.equal(TS.autoSteps(), undefined); TS.readAuto({ auto_steps: false }); assert.equal(TS.autoSteps(), false); TS.readAuto({ auto_steps: true }); assert.equal(TS.autoSteps(), true);
  let n = 0; globalThis.BPStore = { taskReminders: { settings: async () => { n++; return { auto_steps: false }; } } };
  assert.equal(await TS.loadAuto(), false, 'known less than a minute ago'); assert.equal(n, 0); assert.equal(await TS.loadAuto(true), true); assert.equal(TS.autoSteps(), false); assert.equal(await TS.loadAuto(), false); assert.equal(n, 1);
  globalThis.BPStore.taskReminders.settings = async () => { throw new Error('x'); }; assert.equal(await TS.loadAuto(true), false); assert.equal(TS.autoSteps(), false); delete globalThis.BPStore; assert.equal(await TS.loadAuto(true), false);
});
test('timeStep, Ready by, Wrap-up count follow the same function', () => {
  TS.setAuto(false); assert.equal(TS.timeStep(at('2026-11-29', '20:00'), O), 'onday'); assert.equal(TS.timeStep(at('2026-11-28', '20:00'), O), 'daybefore'); assert.equal(TS.timeStep(null, O), ''); assert.equal(TS.timeStep(at('2026-11-29', '20:00'), { eventTime: '19:00' }), '');
  const ready = Date.parse(at('2026-11-29', '18:00')), t = [{ id: 'a', title: 'DJ', duration_min: 60, status: 'accepted', planned_start: at('2026-11-29', '21:00'), step: 'pre' }, { id: 'b', title: 'Stage', duration_min: 60, status: 'accepted', planned_start: at('2026-11-29', '10:00'), step: 'onday' }];
  const src = read('public/event-plan.js'); assert.match(src, /T\.picks && T\.picks\(\) && T\.validStep\(t\.step\)/);
  const s = globalThis.HelmEventSteps._pure.preSummary({ tasks: t, quote: O, tz: O.tz }); assert.deepEqual(s.pre.map((x) => x.id), ['a']); TS.setAuto(true); assert.deepEqual(globalThis.HelmEventSteps._pure.preSummary({ tasks: t, quote: O, tz: O.tz }).pre.map((x) => x.id), ['b']); TS.setAuto(undefined); void ready;
  const g = globalThis.HelmEventWrap._pure.progress; TS.setAuto(false); assert.equal(g({ tasks: [{ id: 'x', title: 'Anything', status: 'completed', step: 'wrapup' }], quote: O, tz: O.tz }, {}).total, 1); TS.setAuto(undefined);
});
test('the store: the step goes with the insert, once; a database without 0438 = the old call; the names live in one place', async () => {
  const blk = /    STEP_RPC: [\s\S]*?\n    assignTasksVendor\([\s\S]*?\n    \},\n/.exec(API)[0], calls = [];
  const make = (missing) => new Function('rpcKeyed', 'rpc', 'rpcMissing', 'return {' + blk + '}')(async (f, o, a) => { calls.push([f, o, a]); if (missing && /step/.test(f)) { const e = new Error('x'); e.code = 'PGRST202'; throw e; } return f; }, async (f, a) => { calls.push([f, a]); return f; }, (e) => e.code === 'PGRST202');
  let S = make(false); assert.equal(await S.assignTasks('q', 'c', ['t'], 'p', 'n', '1', { step: 'pre' }), 'assign_tasks_step'); assert.equal(calls[0][2].p_step, 'pre'); calls.length = 0;
  await S.assignTasks('q', 'c', ['t'], 'p', 'n', '1'); assert.deepEqual([calls[0][0], calls[0][1], 'p_step' in calls[0][2]], ['assign_tasks', 'assign_tasks_once', false]); calls.length = 0; await S.assignTasks('q', 'c', ['t'], 'p', 'n', '1', { step: 'nonsense' }); assert.equal(calls[0][0], 'assign_tasks'); calls.length = 0;
  S = make(true); assert.equal(await S.assignTasksVendor('q', 'c', ['t'], 'v', { step: 'onday' }), 'assign_tasks_vendor'); assert.deepEqual(calls.map((c) => c[0]), ['assign_tasks_vendor_step', 'assign_tasks_vendor']); assert.equal('p_step' in calls[1][2], false); calls.length = 0;
  await S.setTaskStep(['a'], 'pre'); assert.deepEqual(calls[0], ['set_task_step', { p_tasks: ['a'], p_step: 'pre' }]);
  await assert.rejects(new Function('rpcKeyed', 'rpc', 'rpcMissing', 'return {' + blk + '}')(async () => { const e = new Error('plan_locked'); e.code = 'P0001'; throw e; }, null, () => false).assignTasks('q', 'c', ['t'], 'p', 'n', '1', { step: 'pre' }), /plan_locked/, 'a refusal is never retried without the step');
});
test('the pages: opens on Pre-event, sheet default, panel + bulk with a fresh read first, settings box, one read a minute', () => {
  assert.match(BRD, /S\.openStep = S\.autoStep === "daybefore" \? "pre" : S\.autoStep/); assert.match(BRD, /S\.addStep \|\| \(handSteps\(\) \? "pre"/); assert.equal((BRD.match(/function picks\(/g) || []).length, 1, 'the person list keeps its name');
  assert.match(BRD, /String\(n\.step \|\| ""\) !== String\(t\.step \|\| ""\)/); assert.match(BRD, /ids\.slice\(i, i \+ 200\)/); assert.match(BRD, /disabled: planLocked\(\) \? true : null/); assert.match(OPS, /id="bulkStep" hidden/); assert.match(OPS, /titles, c\.id, c\.name, c\.phone, stepOpt\(\)\)/); assert.match(OPS, /titles, vId, stepOpt\(\)\)/);
  assert.match(UI, /"auto_steps" in s \? checkbox\("trs_steps", "Sort tasks into steps automatically"/); assert.match(UI, /if \(steps\) patch\.auto_steps = steps\.input\.checked/); assert.match(UI, /Off: a task stays in the step you pick\. On: Helm decides from its start time and its name\./); assert.match(MON, /TS\.loadAuto\(\)/);
  assert.match(read('public/day-before.js'), /\{ step: "daybefore" \}/); assert.match(read('public/search-catalog.js'), /Sort tasks into steps automatically/);
});
test('no event date: nobody is "free", nothing is ranked by it; crew cards say nothing', () => {
  assert.match(BRD, /This event has no date yet - who is free is not known\./); assert.match(BRD, /!day \? null : h\("span", \{ cls: "tc-avail free"/); assert.match(BRD, /if \(!di \|\| !\(di\.days \|\| \[\]\)\.length\) return null/); assert.match(OPS, /workDay:workDay\(\)/);
});

/* ---- R254-B ---- */
const T = (id, s, e, o = {}) => ({ id, title: id, crew_id: 'r', status: 'accepted', planned_start: s, planned_end: e || null, ...o });
const L = (item, tasks, o) => P.local([item], { tasks, quoteId: 'q', ...o })[0].map((c) => c.task_id);
test('the rule: overlap only, end = start is fine, no time never, status, vendor, other person', () => {
  const s = at('2026-11-29', '17:00'), e = at('2026-11-29', '19:00'), it = { crew_id: 'r', start: s, end: e };
  assert.deepEqual(L(it, [T('a', at('2026-11-29', '18:00'), at('2026-11-29', '20:00'))]), ['a']); assert.deepEqual(L(it, [T('a', e, at('2026-11-29', '20:00'))]), [], 'starts when the other ends'); assert.deepEqual(L(it, [T('a', at('2026-11-29', '15:00'), s)]), []);
  assert.deepEqual(L(it, [T('a', null)]), []); assert.deepEqual(L({ crew_id: 'r', start: null }, [T('a', s, e)]), []); assert.deepEqual(L(it, [T('a', at('2026-11-29', '16:30'), null)]), ['a'], 'about an hour'); assert.deepEqual(L(it, [T('a', at('2026-11-29', '16:30'), null, { duration_min: 30 })]), []);
  for (const st of ['completed', 'cancelled', 'rejected', 'unassigned']) assert.deepEqual(L(it, [T('a', s, e, { status: st })]), [], st); assert.deepEqual(L(it, [T('a', s, e, { status: 'in_progress', verify_status: 'rejected' })]), ['a'], 'rework counts');
  assert.deepEqual(L(it, [T('a', s, e, { assignee_kind: 'outsourced' })]), []); assert.deepEqual(L(it, [T('a', s, e, { crew_id: 'x' })]), []); assert.deepEqual(L({ ...it, id: 'a' }, [T('a', s, e)]), [], 'never with itself'); assert.deepEqual(L(it, [T('a', s, e)], { exclude: ['a'] }), []);
});
test('waiting for the other one (any length, either way) is no clash; a circle ends', () => {
  const s = at('2026-11-29', '17:00'), e = at('2026-11-29', '19:00'), ts = [T('a', s, e), T('b', s, e, { depends_on: 'a' }), T('c', s, e, { depends_on: 'b' }), T('d', s, e)];
  assert.deepEqual(L({ id: 'c', crew_id: 'r', start: s, end: e, depends_on: 'b' }, ts), ['d']); assert.deepEqual(L({ id: 'a', crew_id: 'r', start: s, end: e, depends_on: null }, ts), ['d']); assert.deepEqual(L({ crew_id: 'r', start: s, end: e, depends_on: 'c' }, ts), ['d'], 'a new task');
  const ring = [T('a', s, e, { depends_on: 'b' }), T('b', s, e, { depends_on: 'a' })]; assert.deepEqual(L({ id: 'x', crew_id: 'r', start: s, end: e }, ring), ['a', 'b']);
});
test('midnight and a DST zone: real instants', () => {
  assert.deepEqual(L({ crew_id: 'r', start: at('2026-11-29', '23:30'), end: at('2026-11-30', '01:00') }, [T('a', at('2026-11-30', '00:30'), at('2026-11-30', '02:00')), T('b', at('2026-11-29', '00:30'), at('2026-11-29', '02:00'))]), ['a']);
  // US fall back 1 Nov 2026: 1:30 EDT and 1:30 EST are an hour apart
  assert.deepEqual(L({ crew_id: 'r', start: '2026-11-01T05:30:00Z', duration_min: 60 }, [T('a', '2026-11-01T06:30:00Z', '2026-11-01T07:30:00Z')]), []); assert.deepEqual(L({ crew_id: 'r', start: '2026-11-01T05:30:00Z', duration_min: 61 }, [T('a', '2026-11-01T06:30:00Z', '2026-11-01T07:30:00Z')]), ['a']);
});
test('batch: 60 items a call, 130 people = 3 calls; other events only; old database, failure, both answers', async () => {
  const s = at('2026-11-29', '17:00'), calls = []; let answer = (n) => Array.from({ length: n }, (_, i) => i === 0 ? [{ task_id: 'z', code: 'EV-9', title: 'Stage set-up', start: s, end: at('2026-11-29', '19:00'), same_event: false }, { task_id: 'own', same_event: true, title: 'x', start: s, end: s }] : []);
  globalThis.BPStore = { studioTimezone: () => 'Asia/Kolkata', studioLocale: () => 'en-IN', ops: { timeClashes: async (it, ex) => { calls.push([it.length, ex]); return answer(it.length); } } };
  const items = Array.from({ length: 130 }, (_, i) => ({ crew_id: 'p' + i, start: s, name: 'P' + i })); const f = await TC.find(items, { tasks: [T('t1', null)], quoteId: 'q' });
  assert.deepEqual(calls.map((c) => c[0]), [60, 60, 10]); assert.deepEqual(calls[0][1], ['t1']); assert.equal(f.rows.filter((r) => r.length).length, 3); assert.equal(f.rows[0].length, 1, 'same event rows come from the page');
  let asked = []; globalThis.BPUI = { confirm: async (m, o) => { asked.push([m, o]); return globalThis.__yes; }, toast: (t) => asked.push(['toast', t]) };
  const one = [{ crew_id: 'r', name: 'Ravi', start: s, end: at('2026-11-29', '18:00') }]; globalThis.__yes = true; assert.equal(await TC.ask(one, { tasks: [] }), true);
  assert.match(asked[0][0], /^Ravi already has Stage set-up, EV-9, 5:00-7:00 ?pm\. Give this one too\?$/i); assert.deepEqual([asked[0][1].okLabel, asked[0][1].cancelLabel], ['Give it anyway', 'Not now']); globalThis.__yes = false; assert.equal(await TC.ask(one, { tasks: [] }), false);
  asked = []; globalThis.__yes = true; let days = 0; const day = async () => { days++; return { clash: true, type: 'staff', detail: 'already assigned on 29 Nov to EV-9' }; }, o = { tasks: [], dayText: (c) => 'DAY ' + c.detail };
  assert.equal(await TC.give(one, o, day), true); assert.equal(asked.length, 1, 'the time clash wins for the same event'); asked = []; assert.equal(await TC.give(one, o, async () => ({ clash: true, type: 'unavailable', detail: 'on an approved day off' })), true); assert.equal(asked.length, 2, 'a day off is still asked');
  asked = []; assert.equal(await TC.give([], o, day), true); assert.match(asked[0][0], /^DAY/, 'no start time: the day question as before');
  answer = () => null; asked = []; assert.equal(await TC.ask(one, { tasks: [] }), true); assert.equal(asked.length, 0, 'old database: silent'); assert.equal(await TC.ask(one, { tasks: [T('a', s, null)] }), true); assert.match(asked[0][0], /a, this event, 5:00-about 6:00 ?pm/i);
  answer = () => { throw new Error('down'); }; asked = []; assert.equal(await TC.ask(one, { tasks: [] }), true); assert.deepEqual(asked[0], ['toast', 'Couldn’t check other events.']);
  answer = () => [Array.from({ length: 8 }, (_, i) => ({ task_id: 'k' + i, title: 'T' + i, code: 'E', start: s, end: s }))]; asked = []; await TC.ask(one, { tasks: [] }); assert.match(asked[0][0], /and 3 more\. Give this one too\?/);
  answer = () => [{ i: 0, clashes: [{ task_id: 'q', title: '', start: at('2026-11-30', '00:30'), end: at('2026-11-30', '01:30') }] }]; asked = []; await TC.ask(one, { tasks: [] }); assert.match(asked[0][0], /other work, Mon, 30 Nov, 12:30-1:30 ?am/i, 'an event the caller may not see: only the times');
  delete globalThis.BPStore; delete globalThis.BPUI;
});
test('the same go: equal starts are one quiet line, different starts that overlap are asked', () => {
  const s = at('2026-11-29', '09:00'); globalThis.BPStore = { studioTimezone: () => 'Asia/Kolkata', studioLocale: () => 'en-IN' };
  assert.match(TC.sameStartLine(4, s, 'Ravi', false), /^All 4 start at 9:00 ?am for Ravi - tick One after another, or change the times later\.$/i); assert.equal(TC.sameStartLine(4, s, 'Ravi', true), ''); assert.equal(TC.sameStartLine(1, s, 'Ravi', false), ''); assert.equal(TC.sameStartLine(4, null, 'Ravi', false), '');
  const r = P.local([{ id: 'a', crew_id: 'r', start: s }, { id: 'b', crew_id: 'r', start: s }, { id: 'c', crew_id: 'r', start: at('2026-11-29', '09:30'), title: 'c' }], { tasks: [] }); assert.deepEqual(r.map((x) => x.map((c) => c.task_id)), [['c'], ['c'], ['a', 'b']]); delete globalThis.BPStore;
});
test('wired: assign, reassign, change time, bulk move, day before, issue; tags, chip, needs row; the script on the pages', () => {
  assert.match(OPS, /function askTime\(c, items, exclude, day\)/); assert.equal((OPS.match(/await askTime\(/g) || []).length, 2); assert.match(OPS, /question:"Save this time anyway\?"/); assert.match(BRD, /ok: "Move anyway"/); assert.match(read('public/day-before.js'), /TC\.give\(/); assert.match(read('public/issue-assign.js'), /TC\.give\(/);
  assert.match(BRD, /person has two works at the same time/); assert.match(BRD, /\["same", "Same time"\]/); assert.match(BRD, /sameText\(t\)/); for (const p of ['ops', 'monitor', 'ready', 'issues']) assert.match(read(`public/${p}.html`), /\/task-clash\.js\?v=/, p);
  assert.match(API, /rpc\("crew_time_clashes", \{ p_items: items, p_exclude:/); assert.doesNotMatch(read('public/task-clash.js'), /innerHTML|document\.|insert|update\(/);
});
test('0438 contract: the clash request carries the task and its event; a step move reads in plain words', async () => {
  let got; globalThis.BPStore = { ops: { timeClashes: async (it) => { got = it; return []; } } }; await TC.find([{ id: 'a', crew_id: 'r', start: at('2026-11-29', '17:00'), depends_on: 'b' }], { quoteId: 'q', tasks: [] });
  assert.deepEqual([got[0].id, got[0].quote_id, got[0].depends_on], ['a', 'q', 'b']); delete globalThis.BPStore;
  assert.match(TS.actText({ kind: 'step_changed', title: 'Stage', detail: { from: 'onday', to: 'pre' } }), /Stage.*moved to Pre-event \(was On the event\)/); assert.match(TS.actText({ kind: 'step_changed', title: 'Stage', detail: { from: null, to: 'wrapup' } }), /moved to Wrap-up$/);
  assert.match(BRD, /event_closed: "the event is closed"/);
});
