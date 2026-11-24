// R192: Tasks & Crew page redesign (TASKS-CREW-PAGE-PLAN.md phases 1-6, owner-approved mockup) - frontend only.
//   1 task-status.js: one status vocabulary + late / escalation / check-in rules shared with /monitor
//   2 the studio clock decides "Before the event" / "On the day" (organizations.timezone, never the device zone)
//   3 ONE refresh clock: 30 s while visible, at once when the tab comes back, never two at a time
//   4 ops-board.js pure helpers: move-by, suggested shift, overnight slots, ready checklist, not checked in, stacking
//   5 the page: header / phase switch / attention boxes / 3 views / chips / search / sheet / bulk bar; no 7 s full redraw;
//     no "Add staff" form; start time not behind a tick box; no stale special legend; Smart schedule NOT built (on hold)
//   6 safety: DOM only (no HTML strings) in the new files, feature-detected can't-work Approve / Reject (0370), view-only
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); } };
const TSJS = read('public/task-status.js'), BRD = read('public/ops-board.js'), OPS = read('public/ops.html'), CSS = read('public/ops-board.css'), MON = read('public/monitor.js');

function load(extra) {
  const listeners = {}, doc = Object.assign({ hidden: false, addEventListener(k, f) { listeners[k] = f; }, removeEventListener() {} }, extra && extra.doc);
  const timers = [];
  const W = { document: doc };
  const ctx = { window: W, Intl, Date, Math, Number, String, Object, Array, JSON, isFinite, isNaN, Infinity, Promise,
    setInterval(f) { timers.push(f); return timers.length; }, clearInterval() {} };
  vm.runInNewContext(TSJS, ctx);
  const W2 = { };   // ops-board.js pure part: no document -> only OpsBoard._pure
  const ctx2 = { window: W2, Intl, Date, Math, Number, String, Object, Array, JSON, isFinite, isNaN, Infinity, Promise, setInterval() {}, clearInterval() {} };
  W2.HelmTaskStatus = W.HelmTaskStatus;
  vm.runInNewContext(BRD, ctx2);
  return { TS: W.HelmTaskStatus, B: W2.OpsBoard._pure, timers, listeners, doc };
}
const J = (x) => JSON.parse(JSON.stringify(x));
const { TS, B } = load();

await t('1a one vocabulary: the words both pages use', () => {
  assert.deepEqual(J(TS.LABEL), { unassigned: 'Not assigned', waiting: 'Not accepted yet', accepted: 'Accepted', started: 'Started', done: 'Done', rejected: 'Turned down', cancelled: 'Cancelled', late: 'Late' });
  const k = (s, o) => TS.baseKey(Object.assign({ status: s }, o || {}));
  assert.equal(k('assigned', { crew_id: 'c' }), 'waiting'); assert.equal(k('assigned'), 'unassigned');
  assert.equal(k('unassigned', { assignee_name: 'Asha' }), 'waiting', 'r20: an "unassigned" row that names someone');
  assert.equal(k('in_progress'), 'started'); assert.equal(k('completed'), 'done'); assert.equal(k('rejected'), 'rejected'); assert.equal(k('cancelled'), 'cancelled');
});
await t('1b late = waiting / accepted with a start time already passed; how late; leftover order', () => {
  const now = Date.parse('2026-11-21T10:00:00Z');
  assert.equal(TS.isLate({ status: 'assigned', crew_id: 'c', planned_start: '2026-11-21T09:30:00Z' }, now), true);
  assert.equal(TS.isLate({ status: 'accepted', planned_start: '2026-11-21T09:30:00Z' }, now), true);
  assert.equal(TS.isLate({ status: 'in_progress', planned_start: '2026-11-21T09:30:00Z' }, now), false);
  assert.equal(TS.isLate({ status: 'assigned', crew_id: 'c' }, now), false, 'no start time = never late');
  assert.equal(TS.isLate({ status: 'unassigned', planned_start: '2026-11-21T09:30:00Z' }, now), false, 'no one on it: "No one yet", not late');
  assert.equal(TS.lateMin({ status: 'accepted', planned_start: '2026-11-21T09:30:00Z' }, now), 30);
  assert.equal(TS.shown({ status: 'accepted', planned_start: '2026-11-21T09:30:00Z' }, now), 'late');
  const sm = TS.summarize([{ status: 'completed' }, { status: 'accepted', planned_start: '2026-11-21T09:00:00Z', crew_id: 'a' }, { status: 'cancelled' }], now);
  assert.equal(sm.total, 2); assert.equal(sm.done, 1); assert.equal(sm.late, 1); assert.equal(sm.pct, 50);
});
await t('1c escalation ladder (R186 / 0369): words from the studio steps, recorded step wins, ladder off = none', () => {
  assert.deepEqual(J(TS.ladder({ steps: [0, 5, 10] })), ['Worker', 'Event lead', 'Manager +5 min', 'Admin +10 min']);
  assert.deepEqual(J(TS.ladder({ steps: [2, 7, 15] })), ['Worker', 'Event lead +2 min', 'Manager +7 min', 'Admin +15 min']);
  const now = Date.parse('2026-11-21T10:00:00Z'), ps = '2026-11-21T09:52:00Z';
  const tk = { id: 'T', status: 'assigned', crew_id: 'c', is_special: true, planned_start: ps };
  assert.equal(TS.escStep(tk, null, { steps: [0, 5, 10] }, now), 2, 'no timeline: what the clock says (8 min -> manager)');
  assert.equal(TS.escStep(tk, [{ kind: 'escalated', task_id: 'T', at: '2026-11-21T09:53:00Z', detail: { level: 'coordinator', ref_start: ps } }], { steps: [0, 5, 10] }, now), 1, 'timeline: what really happened');
  assert.equal(TS.escStep(tk, [{ kind: 'escalated', task_id: 'T', at: '2026-11-21T09:00:00Z', detail: { level: 'admin', ref_start: '2026-11-21T08:00:00Z' } }, { kind: 'started', task_id: 'X' }], {}, now), 0, 'an older start time is another ladder');
  assert.equal(TS.escStep(tk, null, { enabled: false }, now), -1);
  assert.equal(TS.escStep(Object.assign({}, tk, { is_special: false }), null, {}, now), -1);
  assert.equal(TS.escBadge({ detail: { level: 'admin' }, at: 'x' }, () => '3:10 PM'), 'Escalated to admin / owner 3:10 PM');
  assert.equal(TS.actText({ kind: 'escalated', title: 'Stage', detail: { level: 'manager' } }), '“Stage” not started - escalated to manager');
});
await t('1d check-in: late against the first start, none without a check-in', () => {
  const fs = Date.parse('2026-11-21T03:30:00Z');
  assert.deepEqual(J(TS.attendance(null, fs)), { state: 'none', late: false, lateMin: 0 });
  assert.equal(TS.attendance({ in: '9:04', inAt: '2026-11-21T03:34:00Z' }, fs).lateMin, 4);
  assert.equal(TS.attendance({ in: '8:50', inAt: '2026-11-21T03:20:00Z', out: '1:15' }, fs).state, 'out');
});
await t('2 the studio clock picks the phase (never the device zone); overnight work counts as "on the day"', () => {
  // 21 Nov 00:30 in Kolkata is still 20 Nov in UTC: the studio's calendar decides
  const now = Date.parse('2026-11-20T19:00:00Z');
  assert.equal(TS.ymdIn('Asia/Kolkata', now), '2026-11-21'); assert.equal(TS.ymdIn('UTC', now), '2026-11-20');
  assert.equal(TS.phase({ eventDate: '2026-11-21', tasks: [], now, tz: 'Asia/Kolkata' }), 'live');
  assert.equal(TS.phase({ eventDate: '2026-11-21', tasks: [], now, tz: 'America/New_York' }), 'plan');
  assert.equal(TS.phase({ eventDate: '2026-11-25', tasks: [], now, tz: 'Asia/Kolkata' }), 'plan');
  // a strike after midnight (event date was yesterday): still "on the day" while the work runs
  const strike = [{ status: 'assigned', planned_start: '2026-11-20T20:00:00Z', planned_end: '2026-11-20T22:00:00Z' }];
  assert.equal(TS.phase({ eventDate: '2026-11-20', tasks: strike, now: Date.parse('2026-11-20T21:00:00Z'), tz: 'Asia/Kolkata' }), 'live');
  // R222: the page now uses TS.opsMode (run-sheet / tasks / Guests arrive / stage); TS.phase stays for older callers
  assert.match(BRD, /TS\.opsMode\(\{ eventDate: evDate\(\), eventTime: q\.eventTime, stage: q\.lifecycleStage \|\| q\.lifecycle_stage, status: q\.status,\s+tasks: G\(\)\.tasks, runsheet: S\.rs, now: Date\.now\(\), tz: tz\(\) \}\)/);
  assert.match(BRD, /function tz\(\) \{ try \{ return B\(\)\.studioTimezone\(\); \}/);
});
await t('3 one refresh clock: 30 s, never while hidden, at once on return, never overlapping', async () => {
  const L = load(); let n = 0;
  const r = L.TS.refresher(() => { n++; }, 30000);
  assert.equal(L.timers.length, 1); assert.equal(L.TS.REFRESH_MS, 30000);
  L.timers[0](); assert.equal(n, 0, 'not before 30 s');
  r.now(); await new Promise((x) => setTimeout(x, 5)); assert.equal(n, 1);
  L.doc.hidden = true; r.now(); await new Promise((x) => setTimeout(x, 5)); assert.equal(n, 2, 'now() forces');
  assert.equal(typeof L.listeners.visibilitychange, 'function');
  r.stop();
  assert.match(BRD, /S\.timer = TS\.refresher\(function \(\) \{ if \(busyElsewhere\(\)\) return; return reload\(true\); \}, TS\.REFRESH_MS\);/);
  assert.match(MON, /TS\.refresher\(function \(\) \{ if \(signedIn\(\)\) return loadTasks\(true\); \}, REFRESH_MS\);/);
  assert.doesNotMatch(OPS, /setInterval\([^)]*7000\)|, 7000\)/, 'the 7-second full redraw is gone');
});
await t('4a bulk "Set time" = move by minutes; suggestion = the worst lateness rounded up to 15 (else +30)', () => {
  assert.equal(B.moveBy('2026-11-21T10:00:00.000Z', 30), '2026-11-21T10:30:00.000Z');
  assert.equal(B.moveBy('2026-11-21T10:00:00.000Z', -15), '2026-11-21T09:45:00.000Z');
  assert.equal(B.moveBy(null, 30), null);
  const now = Date.parse('2026-11-21T10:00:00Z');
  assert.equal(B.suggestShift([{ status: 'accepted', planned_start: '2026-11-21T09:38:00Z' }], now), 30);
  assert.equal(B.suggestShift([{ status: 'accepted', planned_start: '2026-11-21T09:10:00Z' }], now), 60);
  assert.equal(B.suggestShift([{ status: 'accepted', planned_start: '2026-11-21T11:00:00Z' }], now), 30);
});
await t('4b overnight + day-before + no-time slots against the event day (studio calendar)', () => {
  const wall = (iso) => { const d = new Date(Date.parse(iso) + 330 * 60000); return { ymd: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes() }; };
  const s = (iso) => B.slot({ planned_start: iso }, '2026-11-21', wall).where;
  assert.equal(s('2026-11-20T15:30:00Z'), 'before');   // 9 PM the evening before
  assert.equal(s('2026-11-21T08:00:00Z'), 'day');
  assert.equal(s('2026-11-21T20:00:00Z'), 'night');    // 1:30 AM after the sangeet
  assert.equal(s('2026-11-22T08:00:00Z'), 'after');
  assert.equal(B.slot({}, '2026-11-21', wall).where, 'none');
  const st = B.stackRows([{ id: 'a', s: 600, e: 660 }, { id: 'b', s: 630, e: 700 }, { id: 'c', s: 660, e: 720 }]);
  assert.equal(st.rows, 2); assert.equal(st.rowOf.a, 0); assert.equal(st.rowOf.b, 1); assert.equal(st.rowOf.c, 0);
});
await t('4c "Ready for the day?" lines + Fix target; not checked in (first open task started or within 30 min)', () => {
  const tasks = [{ status: 'unassigned' }, { status: 'assigned', crew_id: 'a' }, { status: 'accepted', crew_id: 'b', planned_start: 'x', is_special: true }, { status: 'cancelled' }];
  const items = B.readyChecks(tasks, { clash: (x) => x.crew_id === 'a', unsent: 2 });
  assert.deepEqual(J(items.map((i) => [i[0], i[3]])), [[false, 'none'], [false, 'notime'], [false, 'clash'], [false, 'wait'], [true, 'special'], [true, 'down'], [false, 'people']]);
  assert.equal(items[0][2], '1 task not assigned'); assert.equal(items[6][2], '2 people not sent their tasks yet (Email / WhatsApp)');
  assert.equal(B.readyChecks([{ status: 'rejected', crew_id: 'a' }], {})[5][2], '1 task turned down - give it to someone else');   // R251
  assert.equal(B.readyChecks(tasks, {}).length, 6, 'without the activity timeline the "sent" line is left out');
  assert.equal(B.readyChecks([], {})[0][3], 'add', 'no tasks: one line that opens Add & assign');
  const now = Date.parse('2026-11-21T10:00:00Z');
  const nci = B.notCheckedIn([
    { crew_id: 'a', status: 'accepted', planned_start: '2026-11-21T09:00:00Z' },
    { crew_id: 'b', status: 'accepted', planned_start: '2026-11-21T10:20:00Z' },
    { crew_id: 'c', status: 'accepted', planned_start: '2026-11-21T13:00:00Z' },
    { crew_id: 'd', status: 'completed', planned_start: '2026-11-20T15:00:00Z' },
    { crew_id: 'e', status: 'accepted', planned_start: '2026-11-21T09:00:00Z' }], { e: { in: '9:01' } }, now);
  assert.deepEqual(J(nci.map((x) => [x.crew_id, x.late])), [['a', true], ['b', false]]);
});
await t('5a page layout: header, phase switch, attention, three views, chips, Apple-style search, Monitor link', () => {
  for (const id of ['evhead', 'tcPhase', 'attn', 'tcViews', 'chips', 'tcQ', 'view', 'crewList', 'feed', 'addBtn', 'bulk', 'drawer', 'sheet', 'toMonitor', 'tcViewOnly'])
    assert.ok(OPS.includes(`id="${id}"`), id);
  // R251: three steps right under the event header (Wrap-up is a closed section at the bottom, not a step)
  assert.match(OPS, /data-phase="plan" data-win="daybefore" aria-pressed="false">Day before<\/button>/); assert.match(OPS, /data-phase="live" data-win="pre" aria-pressed="false">Pre-event<\/button>/); assert.match(OPS, /data-phase="live" data-win="onday" aria-pressed="false">On the event<\/button>/);
  assert.match(OPS, /data-view="timeline"[^>]*>Timeline<\/button>/); assert.match(OPS, /data-view="list" aria-pressed="true">By department<\/button>/); assert.match(OPS, /data-view="people"[^>]*>By person<\/button>/);
  assert.match(OPS, /<script src="task-status\.js\?v=\d+"><\/script>/); assert.match(read('public/monitor.html'), /<script src="task-status\.js\?v=\d+"><\/script>\n(<script src="event-plan\.js\?v=\d+"><\/script>\n)?(<script src="day-before\.js\?v=\d+"><\/script>\n)?(<script src="event-floor\.js\?v=\d+"><\/script>\n)?<script src="monitor\.js/);
  assert.match(OPS, /<link rel="stylesheet" href="ops-board\.css\?v=\d+">/);
  // R230: the list view is "Tasks by department" and the page opens on it (saved under a new key)
  assert.match(BRD, /S\.view = v === "timeline" \|\| v === "people" \|\| v === "list" \|\| v === "order" \? v : "list";/);
  assert.match(CSS, /\.tc-search input:focus\{outline:none;background:#fff/);
  assert.match(BRD, /e\.key === "\/" && !typing/, '"/" jumps to search');
});
await t('5b "Venue opens" / "Ready by" only when the event already has them (no new DB fields)', () => {
  assert.match(BRD, /var venueOpens = pick\(\["venueOpens", "venue_opens", "venueAccess", "venue_access"\]\), readyBy = pick\(\["readyBy", "ready_by"\]\);/);
  assert.match(BRD, /if \(venueOpens\) tile\("Venue opens", venueOpens\);/); assert.match(BRD, /if \(readyBy\) tile\("Ready by", readyBy, "key"\);/);
  assert.match(BRD, /if \(guestsAt\) tile\("Guests arrive", guestsAt/);
});
await t('5c the old setup-form page is gone: no Add staff form, no tick box hiding the start time, no stale legend', () => {
  assert.doesNotMatch(OPS, /id="cr_name"|id="cr_phone"|id="cr_add"|addCrew\(/);
  assert.match(OPS, /href="staff\.html">Add them on the Staff page<\/a>/);
  assert.doesNotMatch(OPS, /id="asTimeOn"/); assert.doesNotMatch(OPS, /Add a start time &amp; reminders to these tasks/);
  assert.match(OPS, /<div id="asTimeBox">/, 'the picker is shown, not hidden behind a tick box');
  assert.doesNotMatch(OPS, /id="opsLegend"/); assert.doesNotMatch(OPS + BRD, /every 5 min until it is started \(up to 6\)/);
  assert.doesNotMatch(OPS, /🔔 Mark special|⏱ Schedule|💬 WhatsApp tasks/);
  assert.match(OPS, /Marked special - extra reminders before the start; if it isn't started, the event lead, then the manager, then the admin \/ owner are told\./);
});
await t('5d Smart schedule switch still ON HOLD (phase 7); R226 owns the Ready-by latest start in event-plan.js, not here', () => {
  assert.doesNotMatch(OPS + BRD + CSS, /[Ss]mart schedule|critical path|crit-on|backward/);
});
await t('5e the sheet: when is this work / what / who / start time / tell them, the person list with free / busy / asked off / day off, the button says what happens', () => {
  assert.match(OPS, /<legend><span data-step>2\. <\/span>What<\/legend>/); assert.match(OPS, /<legend><span data-step>3\. <\/span>Who<\/legend>/);
  assert.match(OPS, /<legend><span data-step>1\. <\/span>When is this work\?<\/legend>/);   // R251: the step comes first
  assert.match(OPS, /<legend><span data-step>4\. <\/span>Start time <small>/); assert.match(OPS, /<legend><span data-step>5\. <\/span>Waits for another task <small>/); assert.match(OPS, /<legend><span data-step>6\. <\/span>Tell them<\/legend>/);
  // R251: the same depends_on link and checks as Change time -> Depends on; the task panel starts follow-on work and shows both directions
  assert.match(OPS, /<select class="tc-inp" id="as_dep"/); assert.match(OPS, /setSchedule\(x\.id, when\?when\.start:\(x\.planned_start\|\|null\), null, depFor\(x,mine\)\)/);
  assert.match(OPS, /wouldCycle\(id,depId\)\)\)\{ setMsg\("err","That would go round in a circle/); assert.match(OPS, /sheetOpened:\(preset, depId\)=>/);
  assert.match(BRD, /text: "\+ Task after this"/); assert.match(BRD, /row\("Waiting for this"/); assert.match(BRD, /"data-key": "a:waits"/);
  assert.match(BRD, /text: x\.pending \? "asked for the day off" : "day off"/); assert.match(BRD, /text: "busy elsewhere"/); assert.match(BRD, /text: "● free that day"/); assert.match(BRD, /"★ matches"/);
  assert.match(BRD, /"Assign " \+ n \+ " task" \+ \(n === 1 \? "" : "s"\) \+ " to " \+ who/);
  assert.match(OPS, /id="asSpecial"> ▲ Special \(P1\)/);
  // existing tasks (Give to someone / Reassign / bulk Assign) go through reassign_task, the can't-work confirm stays
  assert.match(OPS, /async function assignPreset\(ids\)\{/); assert.match(OPS, /await BPStore\.ops\.reassign\(t\.id,c\.id,c\.name,c\.phone\)/);
  assert.match(OPS, /if\(clash\.clash && !\(await BPUI\.confirm\(c\.name\+" is "\+clash\.detail\+"\. Assign anyway\?"/);
});
await t('5f approved day off only warns (no automatic unassign); Approve / Reject feature-detected (0370)', () => {
  assert.match(BRD, /sh && typeof sh\.requests === "function" && typeof sh\.decide === "function" \? sh\.requests\("open"\)/);
  assert.match(BRD, /if \(!S\.req \|\| !shifts \|\| typeof shifts\.decide !== "function"\) return \[\];/, 'no box without the server functions');
  assert.match(BRD, /await B0\.ops\.shifts\.decide\(r\.id, what, note \|\| null\);/);
  assert.doesNotMatch(BRD.slice(BRD.indexOf('async function decide('), BRD.indexOf('/* ---- chips + search')), /reassign|cancel\(/, 'approving never moves or cancels tasks');
  assert.match(BRD, /"! approved day off - needs a new person"/);
});
await t('6a safety: DOM only in the new files; status never by colour alone; reduced motion; 44 px targets; 16 px inputs', () => {
  for (const [n, src] of [['ops-board.js', BRD], ['task-status.js', TSJS]]) assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/, n);
  assert.match(CSS, /\.tc-st\.done::before\{content:"\\2713"/); assert.match(CSS, /\.tc-st\.late::before\{content:"!"/); assert.match(CSS, /\.tc-st\.unassigned::before\{background:transparent;border:1\.5px dashed/);
  assert.match(CSS, /@media \(prefers-reduced-motion:reduce\)/);
  assert.match(CSS, /@media \(pointer:coarse\)\{\n  \.tc-btn,\.tc-btn\.sm,\.tc-seg,\.tc-chip,\.tc-opt\{min-height:44px\}/);
  assert.match(CSS, /\.tc-inp,\.tc-search input\{font-size:16px;min-height:44px\}/);
  assert.match(CSS, /\.tc-chips\{flex-wrap:nowrap;overflow-x:auto/, 'chips scroll inside their strip on a phone');
  assert.doesNotMatch(OPS.slice(OPS.indexOf('<body>'), OPS.indexOf('<script')), / style="/, 'no inline style attributes (CSP)');
});
await t('6b dialogs: Esc closes and focus goes back; focus kept inside; rows keep focus across refreshes', () => {
  assert.match(OPS, /<aside class="tc-drawer" id="drawer" role="dialog" aria-modal="true" aria-labelledby="dTitle" hidden>/);
  assert.match(BRD, /if \(e\.key === "Escape"\) \{/); assert.match(BRD, /if \(S\.lastFocus && S\.lastFocus\.isConnected\) try \{ S\.lastFocus\.focus\(\); \}/);
  assert.match(BRD, /function restoreFocus\(root, key\)/); assert.match(BRD, /var fk = focusKey\(old\); old\.parentNode\.replaceChild\(el, old\); restoreFocus\(el, fk\);/);
  assert.match(OPS, /<span class="tc-sr" id="tcAnnounce" aria-live="polite"><\/span>/, '"3 late" read out politely');
});
await t('6c view-only roles: same page, no action buttons, "View only" label', () => {
  assert.match(BRD, /var vo = \$\("#tcViewOnly"\); if \(vo\) vo\.hidden = canEdit\(\);/);
  assert.match(BRD, /var cb = canEdit\(\) && t\.status !== "cancelled"/, 'no tick boxes without Staff edit');
  assert.match(BRD, /if \(canEdit\(\)\) \{\n        var open = all\.filter/, 'no Email / WhatsApp / link buttons on cards');
});
await t('7a R251: the header badge is the REAL step; old hand picks go through normWin; opsWindow gets Guests arrive + the stage', () => {
  assert.deepEqual(['daybefore', 'pre', 'onday', 'wrapup'].map((w) => B.badgeOf(w, 'event_day').text), ['Planning', 'Pre-event', 'Event day - live', 'Event over']);
  assert.equal(B.badgeOf('wrapup', 'settlement').text, 'Complete'); assert.equal(B.badgeOf('wrapup', 'closed').text, 'Complete'); assert.equal(B.badgeOf('daybefore', 'event_day').text, 'Planning', 'the stage alone, days early, never reads as live');
  assert.match(BRD, /badgeOf\(S\.autoWin, stageOf\(\)\)/); assert.doesNotMatch(BRD, /S\.phase === "live" \? "Event day/);
  assert.match(BRD, /TS\.opsWindow\(S\.mode, \{ eventDate: evDate\(\), eventTime: q\.eventTime, stage: stageOf\(\), now: Date\.now\(\), tz: tz\(\) \}\)/);
  // studio time only: a tap just looks; nothing is stored and no "picked by hand" note
  assert.match(BRD, /if \(S\.manual === S\.autoStep \|\| \(was && was !== S\.autoStep\)\) S\.manual = null;/); assert.match(BRD, /w = TS\.normWin\(w\); if \(!w\) return;/);
  assert.match(BRD, /S\.manual = TS\.normWin\("live"\);/); assert.doesNotMatch(BRD + OPS, /Picked by hand|Use the studio|helm\.tc\.phase/);
});
await t('7b R251: the steps are under the header, each step has its own card order, Wrap-up is the last thing on the page and lives in event-steps.js', () => {
  const at = (id) => OPS.indexOf('id="' + id + '"');
  assert.ok(at('evhead') < at('tcSteps') && at('tcSteps') < at('tcPhase') && at('tcPhase') < at('tcFlow') && at('tcFlow') < at('work') && at('work') < at('tcWrap') && at('shiftCard') < at('tcWrap') && at('flowNext') < at('tcWrap'));
  for (const [w, first, last] of [['daybefore', 'tcPrep', 'tcFloor'], ['pre', 'tcDelay', 'tcVendors'], ['onday', 'tcRun', 'tcVendors']]) {
    const list = JSON.parse('[' + BRD.match(new RegExp(w + ': \\[([^\\]]+)\\]'))[1] + ']');
    assert.deepEqual(list.slice(0, 3), ['attn', 'work', first], 'R253: needs you now, then the tasks, on every step'); assert.equal(list[list.length - 1], last); for (const id of list) assert.ok(at(id) > 0, w + ' ' + id);
    for (const id of ['work', 'tcFloor']) assert.ok(list.includes(id), w + ' keeps ' + id);
  }
  const pre = BRD.match(/pre: \[([^\]]+)\]/)[1]; assert.ok(pre.indexOf('"work"') >= 0 && /concat\(TAIL, \["tcPreDone"\]\)/.test(BRD) && /TAIL = \["tcIssues", "tcActCard", "tcCrewCard", "tcPlanRem"\]/.test(BRD), 'Mark pre-event complete ends the step');
  assert.match(BRD, /HelmEventSteps\.renderPreDone\(ph, ctx\)/); assert.match(BRD, /HelmEventWrap\.render\(wh, ctx\)/);
  assert.match(OPS, /<link rel="stylesheet" href="\/event-steps\.css\?v=\d+">/); assert.match(OPS, /<script src="\/event-steps\.js\?v=\d+"><\/script>/);
  assert.doesNotMatch(BRD, /setStageGuided\(|stageBlockers\(|setStage\(/, 'one place moves the stage: event-steps.js');
});
await t('7c R251: default start per step - Venue opens / Ready by side before guests, Guests arrive, after the run-sheet (else + 3 h)', () => {
  const s = (w, o) => J(B.stepStart(w, o)), G = 19 * 60;
  assert.deepEqual(s('pre', { guests: G, venue: 420, ready: 1080 }), { off: 0, min: 420 });
  assert.deepEqual(s('pre', { guests: G, ready: 1080 }), { off: 0, min: 960 }); assert.deepEqual(s('pre', { guests: G }), { off: 0, min: 960 });
  assert.deepEqual(s('pre', {}), { off: 0, min: 540 }); assert.deepEqual(s('pre', { guests: 360, venue: 480, ready: 300 }), { off: 0, min: 180 }, 'a 6 AM event: before guests, never after');
  assert.deepEqual(s('pre', { guests: 30 }), { off: 0, min: 0 }); assert.deepEqual(s('onday', { guests: G }), { off: 0, min: G }); assert.deepEqual(s('onday', {}), { off: 0, min: 1080 });
  assert.deepEqual(s('wrapup', { guests: G, runEnd: 1350 }), { off: 0, min: 1350 }); assert.deepEqual(s('wrapup', { guests: 22 * 60, runEnd: NaN }), { off: 1, min: 60 }); assert.deepEqual(s('wrapup', { guests: G, runEnd: 600 }), { off: 0, min: G + 180 });
  assert.deepEqual(s('daybefore', { guests: G }), { off: -1, min: 1080 });
  assert.equal(B.runEnd([{ start_time: '19:00', duration_min: 60 }, { start_time: '00:30', duration_min: 30 }], G), 1500, 'an item after midnight'); assert.ok(isNaN(B.runEnd([], G)));
});
await t('7d R251: lists are split by step first in all three views; hint only; folded later work; phone-safe', () => {
  assert.match(BRD, /TS\.WINDOWS\.forEach\(function \(W\) \{/); assert.match(BRD, /viewTimeline\(list, w\) : viewPeople\(list, w\)/); assert.match(BRD, /renderGroups\(sec, w, list, keepRows, keepGrps\)/);
  assert.match(BRD, /"Allocate pre-event work first - " \+ n \+ " left"/);
  assert.equal(B.foldDefault('daybefore', 'wrapup', 'daybefore'), false, 'planning: everything open'); assert.equal(B.foldDefault('pre', 'onday', 'pre'), true); assert.equal(B.foldDefault('pre', 'pre', 'pre'), false); assert.equal(B.foldDefault('onday', 'wrapup', 'wrapup'), false, 'open once the event is over');
  assert.deepEqual([...OPS.matchAll(/data-as-step="([a-z]+)" aria-pressed="(true|false)"/g)].map((m) => m[1] + m[2]), ['daybeforefalse', 'pretrue', 'ondayfalse', 'wrapupfalse'], 'R253: in the order of the day; the sheet opens on the step being viewed');
});
await t('7e R251: buttons in the theme accent, no black control left; timeline labels have their own strip', () => {
  assert.doesNotMatch(CSS.replace(/\/\*[\s\S]*?\*\//g, ''), /var\(--tc-black|#2a2a2a/);
  assert.match(CSS, /\.tc-btn\.tc-primary\{background:var\(--tc-acc\);border-color:var\(--tc-acc\);color:var\(--hb-acc-ink,white\)\}/);
  assert.match(CSS, /\.tc a\.tc-btn\.tc-primary,\.tc-layer a\.tc-btn\.tc-primary\{color:var\(--hb-acc-ink,white\)!important\}/);
  assert.match(BRD, /cls: "tc-tl-marks"/); assert.doesNotMatch(BRD, /tc-tl-line mark|"mark"/, 'never the page logo class .mark');
  assert.match(CSS, /\.tc-blk-li\{position:absolute;z-index:1/);
});
await t('6d page tour covers the new page', () => {
  const pt = read('public/page-tours.js');
  for (const s of ['"#evhead"', '"#tcPhase"', '"#attn"', '["#chips", "#tcQ"]', '["#view", "#work"]', '"#addBtn"']) assert.ok(pt.includes('sel: ' + s), s);
});

console.log(`\nr192-tasks-crew: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
