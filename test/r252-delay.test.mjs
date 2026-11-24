// R252 (owner, 24 Nov): "stage is 40 min late, so dinner is at risk" - event-delay.js, the card "Running late - what it affects" on Tasks & Crew
// and the Event-day monitor, and the "Waits for ... - expected done" words on a task. Pure calculation + the wiring of both pages.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const read = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
require('../public/task-status.js'); require('../public/event-plan.js');
const HD = require('../public/event-delay.js');
const JS = read('public/event-delay.js'), CSS = read('public/event-delay.css'), OPS = read('public/ops-board.js'), MON = read('public/monitor.js');

const D = '2026-11-29';
const at = (hm, d = D) => new Date(`${d}T${hm}:00+05:30`).getTime();
const iso = (hm, d) => new Date(at(hm, d)).toISOString();
const clk = (m) => HD.clockIn('Asia/Kolkata')(m);
const T = (id, title, start, dur, o = {}) => ({ id, title, category: 'Stage', status: 'accepted', crew_id: 'c-' + id, assignee_name: 'Asha', planned_start: start ? iso(start) : null, duration_min: dur, ...o });
const run = (tasks, now, o = {}) => HD.compute({ tasks, runsheet: o.rs, plan: o.plan === undefined ? { ready_by: '18:00' } : o.plan, eventDate: D, eventTime: o.guests || '19:00', tz: 'Asia/Kolkata', now: at(now, o.day), live: o.live });
const say = (r, i = 0) => { const w = HD.words(r.rows[i], clk, (t) => t.assignee_name); return [w.cause, ...w.effects]; };

test('the owner\'s case: the stage is late, the flowers move, Ready by slips, dinner is at risk', () => {
  const stage = T('s', 'Stage set-up', '14:00', 60), fl = T('f', 'Mandap flowers', '15:00', 165, { depends_on: 's' });
  const r = run([stage, fl], '14:40', { rs: [{ id: 1, title: 'Photos', start_time: '14:00' }, { id: 2, title: 'Dinner', start_time: '18:15' }] });
  assert.equal(r.live, true); assert.equal(r.rows.length, 1);
  assert.deepEqual(say(r), ['Stage set-up is 40 min late (Asha) - not started.', 'Mandap flowers moves to 3:40 PM (40 min later).', 'Ready by 6:00 PM slips to 6:25 PM (6:59 PM with the safety buffer).', 'Dinner at 6:15 PM (next on the run-sheet) is at risk.']);
  assert.equal(r.rows[0].severity, 'risk'); assert.deepEqual(r.rows[0].moveIds, ['f']); assert.equal(r.rows[0].moveMin, 40);
  // the later tasks moved: they no longer show as moving, but Ready by still does
  fl.planned_start = iso('15:40');
  const r2 = run([stage, fl], '14:40'); assert.deepEqual(say(r2).slice(1), ['Ready by 6:00 PM slips to 6:25 PM (6:59 PM with the safety buffer).']); assert.deepEqual(r2.rows[0].moveIds, []);
});

test('started late, and still running past its time', () => {
  const s = T('s', 'Stage set-up', '14:00', 60, { status: 'in_progress', started_at: iso('14:20') }), f = T('f', 'Flowers', '15:00', 30, { depends_on: 's' });
  let r = run([s, f], '14:30'); assert.equal(say(r)[0], 'Stage set-up is running 20 min late (Asha).'); assert.equal(say(r)[1], 'Flowers moves to 3:20 PM (20 min later).');
  assert.equal(r.rows[0].severity, 'slip');                       // only a later task, under 30 min
  r = run([s, f], '15:35'); assert.equal(r.rows[0].min, 35); assert.equal(r.byId.s.finish, at('15:35')); assert.equal(r.rows[0].severity, 'risk');
  const on = run([T('s', 'Stage set-up', '14:00', 60, { status: 'in_progress', started_at: iso('14:00') }), f], '14:30'); assert.equal(on.rows.length, 0);
});

test('a small slip is no news; room in between swallows a delay', () => {
  const s = T('s', 'Stage', '14:00', 60), f = T('f', 'Flowers', '15:00', 30, { depends_on: 's' });
  assert.equal(run([s, f], '14:04').rows.length, 0);
  assert.equal(run([s, { ...f, planned_start: iso('16:30') }], '14:40').rows.length, 0, 'ends 3:40, flowers planned 4:30');
  assert.equal(run([s], '14:40').rows.length, 0, 'late, but nothing waits for it and Ready by is far: the Late list shows it');
});

test('a chain: every later task moves, the cause is the first one only', () => {
  const ts = [T('a', 'Truss', '12:00', 60), T('b', 'Lights', '13:00', 60, { depends_on: 'a' }), T('c', 'Sound', '14:00', 60, { depends_on: 'b' })];
  const r = run(ts, '13:30'); assert.equal(r.rows.length, 1); assert.equal(r.rows[0].id, 'a');
  assert.deepEqual(r.rows[0].effects.filter((e) => e.kind === 'task').map((e) => [e.id, clk(e.at)]), [['b', '2:30 PM'], ['c', '3:30 PM']]);
  // the first one done late: the next one is late by itself, and only the rest moves
  ts[0].status = 'completed'; ts[0].completed_at = iso('13:20');
  const r2 = run(ts, '13:30'); assert.equal(r2.rows[0].id, 'b'); assert.equal(r2.rows.length, 1);
});

test('unknown durations are never invented: learned ones are used, else "time unknown"', () => {
  const s = T('s', 'Stage set-up', '14:00', null), f = T('f', 'Flowers', '15:00', 30, { depends_on: 's' });
  let r = run([s, f], '14:40'); assert.deepEqual(say(r).slice(1), ['Flowers: new time unknown - Stage set-up has no duration.']); assert.equal(r.rows[0].severity, 'slip');
  assert.deepEqual(HD.waits(f, r, clk), { text: 'Waits for Stage set-up - time unknown', bad: false });
  r = run([s, f], '14:40', { plan: { ready_by: '18:00', learned: [{ title: 'stage set-up', minutes: 60, n: 3 }] } });
  assert.equal(say(r)[1], 'Flowers moves to 3:40 PM (40 min later).');
  r = run([{ ...s, planned_end: iso('15:00') }, f], '14:40'); assert.equal(r.byId.s.dur, 60, 'planned end');
  const st = { ...s, status: 'in_progress', started_at: null, planned_start: null };
  r = run([st, f], '14:40'); assert.equal(Number.isNaN(r.byId.s.finish), true);
});

test('nobody is doing the earlier task: it blocks the later ones', () => {
  const s = T('s', 'Stage set-up', '16:00', 60, { status: 'rejected' }), f = T('f', 'Flowers', '17:00', 30, { depends_on: 's' });
  let r = run([s, f], '10:00'); assert.deepEqual(say(r).slice(0, 2), ['Stage set-up was turned down - nobody is doing it.', 'Flowers cannot start (planned 5:00 PM).']); assert.equal(r.rows[0].severity, 'risk');
  assert.deepEqual(HD.waits(f, r, clk), { text: 'Stage set-up was turned down - nobody is doing it', bad: true });
  assert.deepEqual(r.rows[0].moveIds, [], 'no new times are claimed');
  const u = { ...s, status: 'unassigned', crew_id: null, assignee_name: null };
  assert.equal(run([u, f], '10:00').rows.length, 0, 'not assigned, six hours away: Not assigned covers it');
  r = run([u, f], '13:30'); assert.equal(say(r)[0], 'Stage set-up is not assigned - nobody is doing it.');
  r = run([u, f], '16:20'); assert.equal(say(r)[0], 'Stage set-up has nobody on it - it should have started at 4:00 PM.');
  assert.equal(HD.waits(f, r, clk).text, 'Stage set-up is not assigned - nobody is doing it');
  // cancelled or removed = free
  assert.equal(run([{ ...s, status: 'cancelled' }, f], '16:30').rows.length, 0); assert.equal(HD.waits(f, run([{ ...s, status: 'cancelled' }, f], '16:30'), clk), null);
  assert.equal(HD.waits(f, run([f], '16:30'), clk), null);
});

test('loops and left-out tasks are safe', () => {
  const a = T('a', 'A', '14:00', 60, { depends_on: 'c' }), b = T('b', 'B', '15:00', 60, { depends_on: 'a' }), c = T('c', 'C', '16:00', 60, { depends_on: 'b' });
  const r = run([a, b, c, T('x', 'X', '14:00', 5, { depends_on: 'x' })], '14:40'); assert.ok(r); assert.ok(r.rows.length >= 0);
  assert.equal(run([T('n', 'No time', null, 60)], '14:40').byId.n.skip, true);
  assert.deepEqual(run([], '14:40').rows, []); assert.deepEqual(HD.compute({}).rows, []);
  assert.deepEqual(HD.compute({ tasks: [null, T('s', 'S', '14:00', 60)], eventDate: 'soon', now: at('14:40') }).rows, []);
});

test('before the day: only an impossible order; on the day it says what moves too', () => {
  const s = T('s', 'Stage set-up', '14:00', 60), f = T('f', 'Flowers', '14:30', 30, { depends_on: 's' }), l = T('l', 'Lamps', '15:00', 30, { depends_on: 'f' });
  let r = run([s, f, l], '10:00', { day: '2026-11-27' }); assert.equal(r.live, false); assert.equal(r.rows.length, 1);
  assert.deepEqual(say(r), ['Flowers is planned for 2:30 PM but waits for Stage set-up, which ends at 3:00 PM.']);
  assert.equal(run([s, { ...f, planned_start: iso('15:00') }], '10:00', { day: '2026-11-27' }).rows.length, 0);
  assert.equal(run([{ ...s, status: 'rejected' }, { ...f, planned_start: iso('15:00') }], '10:00', { day: '2026-11-27' }).rows.length, 0, 'before the day: nothing about people');
  r = run([s, f, l], '10:00'); const o = r.rows.find((x) => x.kind === 'order'); assert.deepEqual(o.effects.map((e) => [e.id, clk(e.at)]), [['l', '3:30 PM']]);
  // no duration, but it only starts later
  r = run([T('s', 'Stage', '16:00', null), f], '10:00', { day: '2026-11-27' }); assert.equal(say(r)[0], 'Flowers is planned for 2:30 PM but waits for Stage, which only starts at 4:00 PM.');
});

test('run-sheet lines: an exact name or the first line after the chain, never a guess', () => {
  const s = T('s', 'Stage', '17:00', 60), d = T('d', 'Dinner service', '20:30', 60, { depends_on: 's', category: 'Catering' });
  const r = run([s, d], '20:00', { rs: [{ id: 1, title: 'dinner  service', start_time: '20:30' }, { id: 2, title: 'Dinner speech', start_time: '22:30' }], guests: '19:00' });
  const run1 = r.rows[0].effects.filter((e) => e.kind === 'run').map((e) => e.title); assert.deepEqual(run1, ['dinner  service']);
  assert.equal(r.rows[0].effects.some((e) => e.kind === 'ready' || e.kind === 'guests'), false, 'guests are in: Ready by is history');
});

test('Guests arrive, a tight finish and the ranking', () => {
  const s = T('s', 'Stage', '17:00', 60);
  let r = run([s], '18:30'); assert.deepEqual(say(r).slice(1), ['Ready by 6:00 PM slips to 7:30 PM (7:39 PM with the safety buffer).', 'Guests arrive at 7:00 PM - set-up would end about 7:30 PM.']);
  r = run([T('s', 'Stage', '16:00', 60)], '16:55'); assert.deepEqual(say(r).slice(1), ['Ready by 6:00 PM is at risk - only 5 min to spare.']);
  r = run([T('p', 'Props', '14:00', 30), T('q', 'Paint', '14:30', 30, { depends_on: 'p' }), T('s', 'Stage', '14:00', 300)], '14:20');
  assert.deepEqual(r.rows.map((x) => x.id), ['s', 'p'], 'Ready by at risk first'); assert.deepEqual(r.rows.map((x) => x.severity), ['risk', 'slip']);
});

test('done tasks use their real times; a done earlier task is never waited for', () => {
  const s = T('s', 'Stage', '14:00', 60, { status: 'completed', completed_at: iso('14:30') }), f = T('f', 'Flowers', '15:00', 30, { depends_on: 's' });
  const r = run([s, f], '14:40'); assert.equal(r.rows.length, 0); assert.equal(HD.waits(f, r, clk), null);
});

test('the file: no HTML strings, no inline style, no fixed hex, no read or save; the rules are written down', () => {
  assert.doesNotMatch(JS, /innerHTML|insertAdjacentHTML|\.style\b|setInterval|BPStore|fetch\(/);
  assert.doesNotMatch(CSS, /#[0-9a-f]{3,8}\b(?![^{]*\{)/i); assert.doesNotMatch(CSS.replace(/\/\*[\s\S]*?\*\//g, ''), /#[0-9a-fA-F]{3,6}/);
  assert.match(CSS, /min-height:44px/); assert.match(JS, /SLACK = 5/); assert.match(JS, /TIGHT = 10/); assert.match(JS, /role: "status", "aria-live": "polite"/);
});
test('both pages: same card, the existing actions, the plan lock, no extra read', () => {
  for (const p of ['ops', 'monitor']) { const h = read(`public/${p}.html`); assert.match(h, /\/event-delay\.js\?v=\d+/); assert.match(h, /\/event-delay\.css\?v=\d+/); }
  assert.match(OPS, /pre: \["tcReady", "tcDelay",/); assert.match(OPS, /onday: \["tcRun", "tcDelay",/);
  const ob = OPS.slice(OPS.indexOf('function renderDelay'), OPS.indexOf('function planLocked'));
  assert.match(ob, /locked: planLocked\(\)/); assert.match(ob, /move: canEdit\(\) \? function \(ids, m\)[^\n]*!planLocked\(\)\) openMove\(ts, m\)/); assert.match(ob, /P\(\)\.mail\(b, t\.id, false\)/);
  assert.doesNotMatch(ob, /await|BPStore|B\(\)/);
  assert.match(OPS, /function openMove\(ts, m\)/); assert.match(OPS, /renderRun\(\); renderDelay\(\); renderFloor\(\);/, 'the minute clock');
  const mb = MON.slice(MON.indexOf('function delayRes'), MON.indexOf('the event\'s issues (the same list'));
  assert.doesNotMatch(mb, /await|BPStore/); assert.match(mb, /nudgeEl: remindBtn/); assert.doesNotMatch(mb, /move:/);
});
