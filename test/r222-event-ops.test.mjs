// R222: event operations phase 1 (EVENT-OPS-PLAN.md) - Tasks & Crew, frontend only (no database change).
//   1 HelmTaskStatus.opsMode: the rule that picks Before the event / On the day (studio clock, run-sheet, tasks, Guests
//     arrive, stage), and why
//   2 ops-board pure helpers: crew availability words, run-sheet now / next
//   3 the page: containers, manual switch kept (+ #live fixed), Before = Get set up, On the day = run-sheet / issues / wrap up
//   4 permissions + safety: issues through BPStore.issues (Issues area), stage through setStageGuided (0198 gates,
//     Quotes - Can change), DOM only, no migration, tour updated
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); } };
const TSJS = read('public/task-status.js'), BRD = read('public/ops-board.js'), OPS = read('public/ops.html'), CSS = read('public/ops-board.css'), TOURS = read('public/page-tours.js');

const base = { Intl, Date, Math, Number, String, Object, Array, JSON, isFinite, isNaN, Infinity, Promise, setInterval() {}, clearInterval() {} };
const W = {}; vm.runInNewContext(TSJS, Object.assign({ window: W }, base));
const TS = W.HelmTaskStatus;
const W2 = { HelmTaskStatus: TS }; vm.runInNewContext(BRD, Object.assign({ window: W2 }, base));
const B = W2.OpsBoard._pure;
const tz = 'Asia/Kolkata', at = (iso) => Date.parse(iso);
// Sat 21 Nov 2026, IST (+05:30): first task 9:00 AM (03:30Z), run-sheet 3:00 PM, Guests arrive 7:00 PM
const EV = { eventDate: '2026-11-21', eventTime: '7:00 PM', stage: 'ready', status: 'confirmed', tz,
  runsheet: [{ start_time: '15:00:00', duration_min: 30 }], tasks: [{ status: 'accepted', planned_start: '2026-11-21T03:30:00Z' }] };
const M = (o) => TS.opsMode(Object.assign({}, EV, o));

await t('1a wall clock: studio time zone to an instant (never the device zone)', () => {
  assert.equal(new Date(TS.wallMs('2026-11-21', 7 * 60, tz)).toISOString(), '2026-11-21T01:30:00.000Z');
  assert.equal(new Date(TS.wallMs('2026-11-21', 0, 'America/New_York')).toISOString(), '2026-11-21T05:00:00.000Z');
  assert.equal(TS.hmMin('19:00'), 1140); assert.equal(TS.hmMin('7:00 PM'), 1140); assert.equal(TS.hmMin('12:30 am'), 30);
  assert.equal(TS.hmMin('15:00:00'), 900); assert.ok(isNaN(TS.hmMin('')), 'no time'); assert.ok(isNaN(TS.hmMin('25:00')));
});
await t('1b days before: Before the event; the day starts 1 h before the first thing on the event day', () => {
  const m = M({ now: at('2026-11-19T12:00:00Z') });
  assert.equal(m.mode, 'plan'); assert.equal(m.step, 'before');
  assert.equal(new Date(m.from).toISOString(), '2026-11-21T02:30:00.000Z', '9:00 AM task - 1 h = 8:00 AM IST');
  const soon = M({ now: at('2026-11-21T01:00:00Z') });   // 6:30 AM on the day
  assert.equal(soon.mode, 'plan'); assert.equal(soon.step, 'soon');
});
await t('1c on the day from the start until 6 h after the last item (or the end of the day), then "over"', () => {
  assert.equal(M({ now: at('2026-11-21T02:31:00Z') }).mode, 'live');
  assert.equal(M({ now: at('2026-11-21T02:31:00Z') }).step, 'on');
  const m = M({ now: at('2026-11-21T19:00:00Z') });   // 00:30 IST next day: within 6 h after Guests arrive (7 PM)
  assert.equal(m.step, 'on'); assert.equal(new Date(m.to).toISOString(), '2026-11-21T19:30:00.000Z');
  const over = M({ now: at('2026-11-22T12:00:00Z') });
  assert.equal(over.mode, 'live', 'a past event that is not complete stays on the day (wrap up)'); assert.equal(over.step, 'over');
});
await t('1d the first thing on the day wins: run-sheet before tasks, Guests arrive alone, nothing = midnight', () => {
  assert.equal(new Date(M({ runsheet: [{ start_time: '06:00' }], now: 0 }).from).toISOString(), '2026-11-20T23:30:00.000Z', '6:00 AM item - 1 h = 5:00 AM IST');
  assert.equal(new Date(M({ runsheet: [], tasks: [], now: 0 }).from).toISOString(), '2026-11-21T12:30:00.000Z', 'only Guests arrive 7 PM -> 6 PM');
  const bare = M({ runsheet: [], tasks: [], eventTime: '', now: at('2026-11-20T18:31:00Z') });   // 00:01 IST on the day
  assert.equal(bare.mode, 'live', 'no times at all: the event date (studio midnight) as before');
  assert.equal(new Date(bare.to).toISOString(), '2026-11-21T18:30:00.000Z', 'ends at the end of the event day');
});
await t('1e set-up the day before stays Before; a strike after midnight keeps the day open', () => {
  const setup = [{ status: 'accepted', planned_start: '2026-11-20T12:30:00Z', planned_end: '2026-11-20T15:30:00Z' }];   // 6 PM the day before
  assert.equal(M({ tasks: setup, runsheet: [], eventTime: '', now: at('2026-11-20T13:00:00Z') }).mode, 'plan');
  const strike = [{ status: 'accepted', planned_start: '2026-11-21T20:00:00Z', planned_end: '2026-11-21T23:00:00Z' }];   // 1:30-4:30 AM next day
  const m = M({ tasks: strike, runsheet: [], eventTime: '', now: at('2026-11-22T03:00:00Z') });
  assert.equal(m.step, 'on', '6 h after the strike ends'); assert.equal(new Date(m.to).toISOString(), '2026-11-22T05:00:00.000Z');
  assert.equal(M({ tasks: [{ status: 'cancelled', planned_start: '2026-11-21T00:30:00Z' }], runsheet: [], eventTime: '', now: 0 }).from, TS.wallMs('2026-11-21', 0, tz), 'cancelled tasks do not count');
});
await t('1f the stage and status: cancelled = Before, Settlement / Closed = done, Event Day opens the day', () => {
  assert.deepEqual([M({ status: 'cancelled' }).mode, M({ status: 'cancelled' }).step], ['plan', 'cancelled']);
  assert.deepEqual([M({ stage: 'settlement' }).mode, M({ stage: 'settlement' }).step], ['live', 'done']);
  assert.equal(M({ stage: 'closed', now: at('2026-11-19T12:00:00Z') }).step, 'done');
  assert.equal(M({ stage: 'event_day', now: at('2026-11-21T00:00:00Z') }).mode, 'live', 'stage moved to Event Day at 5:30 AM: on the day');
  assert.equal(M({ stage: 'event_day', now: at('2026-11-19T12:00:00Z') }).mode, 'plan', 'never before the date');
  assert.deepEqual([M({ eventDate: '' }).mode, M({ eventDate: '' }).step], ['plan', 'nodate']);
  assert.equal(TS.phase({ eventDate: '2026-11-21', tasks: [], now: at('2026-11-21T06:00:00Z'), tz }), 'live', 'R192 phase() kept for older callers');
});

// crew availability (coordinator, owner priority): the same rules as crew_day_status / crew_unavailable_conflicts /
// crew_availability_range, so the card and the readiness line "No one is booked on a day they can't work" never disagree
const dayIST = (t) => (t.planned_start ? TS.ymdIn(tz, t.planned_start) : '2026-11-21');   // the board's taskDay: studio zone, else the event day
const offMap = (m) => (id, d) => (m[id] && m[id][d]) || null;
const bookMap = (m) => (id, d) => (m[d] === undefined ? null : (m[d][id] || []));
const T1 = (id, iso, st) => ({ crew_id: id, status: st || 'accepted', planned_start: iso });
const word = (info) => B.availWord(info, '2026-11-21').text;
await t('2a free: no other event and no day off that day', () => {
  const i = B.crewDay('c1', [T1('c1', '2026-11-21T03:30:00Z')], '2026-11-21', dayIST, offMap({}), bookMap({ '2026-11-21': {} }));
  assert.equal(i.state, 'free'); assert.equal(word(i), 'Free that day'); assert.equal(i.unknown, false);
  assert.doesNotMatch(BRD, /text: "Free" \}/, 'no bare "Free" left');
});
await t('2b busy elsewhere: a task on another event the same studio day, naming the event (crew_day_status booked codes)', () => {
  const i = B.crewDay('c1', [T1('c1', '2026-11-21T03:30:00Z')], '2026-11-21', dayIST, offMap({}), bookMap({ '2026-11-21': { c1: ['EVT-102'] } }));
  assert.equal(i.state, 'busy'); assert.equal(word(i), 'Busy elsewhere · EVT-102');
  const two = B.crewDay('c1', [], '2026-11-21', dayIST, offMap({}), bookMap({ '2026-11-21': { c1: ['EVT-102', 'EVT-110'] } }));
  assert.equal(word(two), 'Busy elsewhere · EVT-102 +1');
  assert.equal(word(B.crewDay('c1', [], '2026-11-21', dayIST, offMap({}), bookMap({ '2026-11-21': { c1: [''] } }))), 'Busy elsewhere', 'no code known: no name');
  assert.match(BRD, /sh\.dayStatus\(d, q\)/, 'crew_day_status with this event left out (p_exclude_quote)');
});
await t('2c day off approved / asked (pending, 0370) wins over busy; the readiness line flags the same task', () => {
  const tasks = [T1('c1', '2026-11-21T03:30:00Z')];
  const ap = B.crewDay('c1', tasks, '2026-11-21', dayIST, offMap({ c1: { '2026-11-21': { pending: false, note: 'wedding' } } }), bookMap({ '2026-11-21': { c1: ['EVT-102'] } }));
  assert.equal(ap.state, 'off'); assert.equal(word(ap), 'Day off');
  const pe = B.crewDay('c1', tasks, '2026-11-21', dayIST, offMap({ c1: { '2026-11-21': { pending: true } } }), bookMap({}));
  assert.equal(pe.state, 'asked'); assert.equal(word(pe), 'Asked for the day off');
  const clash = (t) => !!offMap({ c1: { '2026-11-21': { pending: true } } })(t.crew_id, dayIST(t));
  const rc = B.readyChecks(tasks, { clash }); assert.equal(rc[2][0], false, 'readiness: 1 task clashes'); assert.match(rc[2][2], /1 task clash/);
  // a done task no longer clashes on either side (crew_unavailable_conflicts leaves completed out too)
  const done = [T1('c1', '2026-11-21T03:30:00Z', 'completed'), T1('c1', '2026-11-22T03:30:00Z')];
  const d2 = B.crewDay('c1', done, '2026-11-21', dayIST, offMap({ c1: { '2026-11-21': { pending: false } } }), bookMap({}));
  assert.equal(d2.state, 'free', 'their only open work is on the 22nd'); assert.equal(B.readyChecks(done, { clash: (t) => t.status !== 'completed' && !!offMap({ c1: { '2026-11-21': {} } })(t.crew_id, dayIST(t)) })[2][0], true);
});
await t('2d multi-day events: every day they work here counts; the card names the other day', () => {
  const tasks = [T1('c1', '2026-11-20T12:30:00Z'), T1('c1', '2026-11-21T03:30:00Z'), T1('c1', '2026-11-22T04:00:00Z', 'cancelled')];
  const free = B.crewDay('c1', tasks, '2026-11-21', dayIST, offMap({}), bookMap({ '2026-11-20': {}, '2026-11-21': {} }));
  assert.deepEqual(JSON.parse(JSON.stringify(free.days)), ['2026-11-20', '2026-11-21'], 'cancelled work on the 22nd does not count'); assert.equal(word(free), 'Free those days');
  const off = B.crewDay('c1', tasks, '2026-11-21', dayIST, offMap({ c1: { '2026-11-20': { pending: false } } }), bookMap({}));
  assert.equal(off.state, 'off'); assert.equal(B.availWord(off, '2026-11-21', (d) => 'Fri 20 Nov').text, 'Day off (Fri 20 Nov)');
  const busy = B.crewDay('c1', tasks, '2026-11-21', dayIST, offMap({}), bookMap({ '2026-11-20': { c1: ['EVT-099'] }, '2026-11-21': {} }));
  assert.equal(busy.state, 'busy'); assert.equal(busy.day, '2026-11-20');
  const unknown = B.crewDay('c1', tasks, '2026-11-21', dayIST, offMap({}), bookMap({ '2026-11-21': {} }));
  assert.equal(unknown.state, 'free'); assert.equal(unknown.unknown, true, 'a day with no answer yet is marked unknown');
  assert.match(BRD, /wdays\.forEach\(function \(d\) \{ if \(d < from\) from = d; if \(d > to\) to = d; \}\);/, 'can\'t-work days read for every work day');
});
await t('2e studio time zone around midnight IST: 00:15 IST is the next day, 23:45 IST the same day', () => {
  const late = T1('c1', '2026-11-20T18:15:00Z'), early = T1('c1', '2026-11-20T18:45:00Z');   // 23:45 IST 20th / 00:15 IST 21st
  assert.equal(dayIST(late), '2026-11-20'); assert.equal(dayIST(early), '2026-11-21');
  const offs = offMap({ c1: { '2026-11-21': { pending: false } } });
  assert.equal(B.crewDay('c1', [early], '2026-11-21', dayIST, offs, bookMap({})).state, 'off', 'the 00:15 task is on the day off');
  assert.equal(B.crewDay('c1', [late], '2026-11-21', dayIST, offs, bookMap({ '2026-11-20': {} })).state, 'free', 'the 23:45 task is the day before');
  assert.equal(TS.ymdIn('UTC', Date.parse('2026-11-20T18:45:00Z')), '2026-11-20', 'the device / UTC day would be wrong - never used');
  assert.match(BRD, /function taskDay\(t\) \{ var w = t\.planned_start && wall\(t\.planned_start\); return w \? w\.ymd : evDate\(\); \}/);
});
await t('2f run-sheet now / next / done from the studio minutes; no clock = no states', () => {
  const items = [{ id: 'a', start_time: '15:00:00', duration_min: 30 }, { id: 'b', start_time: '17:00', duration_min: 60 }, { id: 'c', start_time: '19:00' }, { id: 'd', start_time: null }];
  const r = B.runRows(items, 16 * 60 + 50).map((x) => [x.r.id, x.state]);
  assert.deepEqual(r, [['a', 'done'], ['b', 'next'], ['c', 'later'], ['d', 'none']]);
  assert.equal(B.runRows(items, 16 * 60 + 50)[1].inMin, 10);
  assert.deepEqual(B.runRows(items, 17 * 60 + 5).map((x) => x.state), ['done', 'now', 'next', 'none']);
  assert.deepEqual(B.runRows(items, 19 * 60 + 5).map((x) => x.state).slice(0, 3), ['done', 'done', 'now'], 'a point item is "now" for 15 min');
  assert.deepEqual(B.runRows(items, null).map((x) => x.state), ['none', 'none', 'none', 'none']);
  assert.deepEqual(B.runRows([{ id: 'z', start_time: '20:00' }, { id: 'y', start_time: '09:00' }], 0).map((x) => x.r.id), ['y', 'z'], 'sorted by time');
});

await t('3a the page: switch kept, Get set up, run-sheet, issues and wrap-up boxes', () => {
  assert.match(OPS, /data-phase="plan" (data-win="before" )?aria-pressed="false">Before the event<\/button>/);   // R226: + data-win
  assert.match(OPS, /data-phase="live" (data-win="onday" )?aria-pressed="false">On the day<\/button>/);
  assert.match(OPS, /id="tcPhaseAuto" hidden>Use the studio’s clock<\/button>/);
  for (const id of ['tcPrep', 'tcRun', 'tcIssues', 'tcWrap']) assert.match(OPS, new RegExp('id="' + id + '"[^>]*hidden'), id + ' starts hidden');
  assert.match(BRD, /card\("tcPrep", S\.phase === "plan"/); assert.match(BRD, /card\("tcRun", S\.phase === "live" (&& S\.win !== "wrapup" )?&& Array\.isArray\(S\.rs\)\)/);
  assert.match(BRD, /card\("tcIssues", S\.phase === "live" && Array\.isArray\(S\.iss\)\)/);
  assert.match(BRD, /renderPrep\(\); (renderPlan\(\); )?renderRun\(\); renderAttn\(\); renderIssues\(\); renderWrap\(\);/);
  for (const l of ['"staff.html"', '"resources.html?quote="', '"vendors.html"', '"runsheet.html?quote="', 'builderHref()', '"ready.html?quote="']) assert.ok(BRD.includes(l), 'Get set up links ' + l);
});
await t('3b the note says why; a hand pick that matches the clock is dropped; #live sticks', () => {
  assert.match(BRD, /"From the studio’s clock" \+ \(why \? " · " \+ why : ""\)/);
  assert.match(BRD, /"Picked by hand · the studio’s clock says "/);
  assert.match(BRD, /if \(S\.manual === (auto|S\.autoWin)\) \{ ssSet\(key, null\); S\.manual = null; \}/);   // R226: the window
  assert.match(BRD, /location\.hash === "#live" && G\(\)\.quoteId && modeNow\(\)\.mode !== "live"\) ssSet\(phaseKey\(\), "live"\)/);
  assert.doesNotMatch(BRD, /=== "#live"\) \{ S\.phase = "live";/, 'the old one-shot flip (undone by the next refresh) is gone');
  assert.match(CSS, /\.tc-phase-row \.tc-seg\[aria-pressed="true"\]\{background:var\(--tc-black\);color:#fff/, 'black like + Add & assign and the All chip');
});
await t('3c crew cards and the side list use the words; busy elsewhere comes from the staff suggestions', () => {
  assert.match(BRD, /if \(S\.phase === "plan"\) io = availPill\(c\.id\);/);
  assert.match(BRD, /if \(!live\) io = availPill\(c\.id\);/);
  assert.match(BRD, /function dayInfo\(crewId\) \{ return crewDay\(crewId, G\(\)\.tasks, evDate\(\), taskDay, offOn, bookedOn\); \}/, 'one source for every card');
  assert.match(OPS, /booked:bookedIds/, 'the Add & assign list uses crew_day_status too');
  assert.match(OPS, /OpsBoard\.picks\(\); OpsBoard\.update\(\);/, 'the cards redraw once the suggestions are in');
});

await t('4a issues: the existing BPStore.issues (Issues area: view to see, Can change to log / resolve)', () => {
  assert.match(BRD, /A\.canView\("issues"\)/); assert.match(BRD, /A\.canEditArea\("issues"\)/);
  assert.match(BRD, /issEdit: r\[1\] && r\[2\]/);
  assert.match(BRD, /B\(\)\.issues\.add\(qid\(\), \{ kind: kind, title: t, severity: sev, owner: o \|\| null \}\)/);
  assert.match(BRD, /B\(\)\.issues\.setStatus\(i\.id, "resolved"\)/);
  assert.match(BRD, /if \(t\.length > 500\)/, 'same 500-character limit as the Issues page');
  assert.match(BRD, /"issues\.html\?quote="/);
});
await t('4b mark complete: setStageGuided to Settlement (0198 gates + admin override), Quotes - Can change, confirm first', () => {
  assert.match(BRD, /A\.canEditArea\("quotes"\)/);
  assert.match(BRD, /B\(\)\.quotes\.stageBlockers\(qid\(\), "settlement"\)/);
  assert.match(BRD, /B\(\)\.quotes\.setStageGuided\(qid\(\), "settlement"\)/);
  assert.match(BRD, /BPUI\.confirm\("Mark "/);
  assert.match(BRD, /can = !blocked \|\| \(p\.admin && !hard\.length\)/, 'blocked = disabled; an admin may override soft gates (server asks for the reason)');
  assert.match(BRD, /if \(S\.stageBusy\) return;/, 'one move at a time');
  assert.match(BRD, /if \(e\.detail > 1\) return; markComplete/, 'a double-click never moves twice');
  assert.doesNotMatch(BRD, /setStage\(qid\(\)/, 'never the unguarded setStage');
  for (const p of ['settlement.html', 'teardown.html', 'closure.html']) assert.ok(BRD.includes('"' + p + '"'), 'next step ' + p);
});
await t('4c safety: DOM only in ops-board.js, no migration 0396 in phase 1, tour updated', () => {
  assert.doesNotMatch(BRD, /innerHTML|insertAdjacentHTML|outerHTML/);
  // R226 used the reserved 0396 (phase 4: Ready by / Venue opens) - only its own file
  assert.deepEqual(readdirSync(new URL('../supabase/migrations/', import.meta.url)).filter((f) => /^0396/.test(f)), ['0396_r226_event_day_plan.sql']);
  // the tour keeps its 8 steps (page-tours-coverage: 4-8 a page); the changed steps say what is new (R226 wording)
  assert.match(TOURS, /On the day starts 1 hour before the first run-sheet item, task or guest arrival/);
  assert.match(TOURS, /\+ Log an issue, and Mark event complete - it moves on to Settlement, Teardown and Closure/);
  assert.match(TOURS, /Free that day \/ Busy elsewhere - the other event is named \/ Day off/);
});

console.log(`r222-event-ops: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
