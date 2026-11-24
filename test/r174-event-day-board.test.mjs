// r174-event-day-board.test.mjs - R174 (owner, 16 Nov 2026): staff availability on the office calendar, event-day progress
// (Tasks & staff summary + Calendar "Live today"), home page "Ongoing & upcoming today", schedule day in the studio time zone.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const r = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n    ' + (e && e.message)); } };

const MIG = r('supabase/migrations/0365_r174_event_day_board.sql');
const APPLY = r('supabase/APPLY-0365.sql');
const LB = r('public/live-board.js');
const CS = r('public/crew-schedule.js');
const CAL = r('public/calendar.html');
const OPS = r('public/ops.html');
const DASH = r('public/dashboard.html');
const API = r('public/store-api.js');

// run live-board.js in a tiny browser-like sandbox to test the pure counts
function board() {
  const ctx = { window: {}, document: { addEventListener() {}, hidden: false }, setInterval() { return 1; }, clearInterval() {}, Intl, Date, Math, Number, String, Object, Array, isFinite, Promise };
  vm.createContext(ctx); vm.runInContext(LB, ctx);
  return ctx.window.HelmLiveBoard;
}

t('0365: schedule day in the studio time zone (no UTC), live board + unavailable conflicts, functions only', () => {
  assert.match(MIG, /create or replace function public\.crew_schedule\(p_from date, p_to date, p_staff uuid default null\)/);
  const body = MIG.slice(MIG.indexOf('create or replace function public.crew_schedule'), MIG.indexOf('-- ---- 2)'));
  assert.ok(!/at time zone 'UTC'/.test(body), 'crew_schedule must not use UTC days');
  assert.match(body, /at time zone v_tz\)::date/);
  assert.match(MIG, /create or replace function public\.live_events_today\(p_hours integer default 24\)/);
  assert.match(MIG, /create or replace function public\.crew_unavailable_conflicts\(p_from date, p_to date\)/);
  assert.doesNotMatch(MIG.replace(/^--.*$/gm, ''), /\b(create|alter|drop)\s+table\b|\bdelete\s+from\b|\btruncate\b|\binsert\s+into\b|\bupdate\s+public\./i);
  assert.ok(!/^--.*'/m.test(MIG), 'editor-safe: no apostrophes in comments');
});

t('0365: office roles only (crew / anon refused), own studio, hours capped, 92-day cap', () => {
  assert.match(MIG, /coalesce\(v_role, ''\) in \('crew', 'worker'\)/);
  assert.match(MIG, /least\(greatest\(coalesce\(p_hours, 24\), 1\), 72\)/);
  assert.match(MIG, /p_to - p_from > 92/);
  assert.match(MIG, /revoke all on function %s from anon/);
});

t('APPLY-0365 = the migration between begin / commit, ASCII, editor-safe header', () => {
  assert.equal(APPLY.slice(APPLY.indexOf('begin;\n') + 7, APPLY.lastIndexOf('\ncommit;')).trim(), MIG.trim());
  assert.match(APPLY, /^-- APPLY-0365 \(R174 [^\n]*\)\. Run on STAGING first, then production\. Safe to run twice\.\n/);
  assert.ok(/^[\x00-\x7f]*$/.test(APPLY), 'ASCII only');
  assert.ok(!/^--.*'/m.test(APPLY), 'no apostrophes in comment lines');
  assert.ok(r('supabase/migrations/MANIFEST').includes('forward  supabase/migrations/0365_r174_event_day_board.sql'));
  assert.match(r('scripts/db-test/run-all.sh'), /R174-EVENT-DAY-BOARD-0365: ALL PASS \\\(19\/19\\\)/);
});

t('summarize(): done / started / accepted / waiting / late / turned down, cancelled ignored, latest activity', () => {
  const B = board(), now = Date.parse('2026-11-16T12:00:00Z');
  const iso = (m) => new Date(now + m * 60000).toISOString();
  const c = B.summarize([
    { id: 1, status: 'completed', crew_id: 'a', assignee_name: 'Ravi', title: 'Backdrop', planned_start: iso(-180), completed_at: iso(-60) },
    { id: 2, status: 'in_progress', crew_id: 'b', assignee_name: 'Sita', title: 'Drinks', planned_start: iso(-20), started_at: iso(-10) },
    { id: 3, status: 'accepted', crew_id: 'c', assignee_name: 'Arun', title: 'Lights', planned_start: iso(-15), responded_at: iso(-60) },
    { id: 4, status: 'assigned', crew_id: 'c', assignee_name: 'Arun', title: 'Floor', planned_start: iso(120) },
    { id: 5, status: 'rejected', crew_id: 'b', assignee_name: 'Sita', title: 'Plates', responded_at: iso(-30) },
    { id: 6, status: 'cancelled', crew_id: 'a', assignee_name: 'Ravi', title: 'Old' },
  ], now);
  assert.equal(c.total, 5); assert.equal(c.done, 1); assert.equal(c.started, 1); assert.equal(c.accepted, 1);
  assert.equal(c.waiting, 1); assert.equal(c.rejected, 1); assert.equal(c.late, 1);
  assert.equal(c.lateList[0].title, 'Lights'); assert.equal(c.pct, 20);
  assert.equal(c.staff, 3); assert.equal(c.staffConfirmed, 3);
  assert.equal(c.last.kind, 'started'); assert.equal(c.last.who, 'Sita');
  assert.equal(c.nextStart, now + 120 * 60000);
});

t('live-board.js: DOM only (textContent), refresh every 60 s while visible, hidden before 0365', () => {
  assert.doesNotMatch(LB, /innerHTML|insertAdjacentHTML|document\.write/);
  assert.match(LB, /var REFRESH_MS = 60000;/);
  assert.match(LB, /if \(data == null\) \{ el\.hidden = true;/);
  assert.match(LB, /ops\.html\?quote=" \+ encodeURIComponent\(ev\.quote_id\) \+ "#live"/);
});

t('store-api: BPStore.ops.live.today + shifts.unavailableConflicts; suggestions say "can\'t work" apart from busy', () => {
  assert.match(API, /rpc\("live_events_today", \{ p_hours: hours \|\| 24 \}\)/);
  assert.match(API, /rpc\("crew_unavailable_conflicts", \{ p_from: from, p_to: to \}\)/);
  assert.match(API, /off: off\.has\(c\.id\), offNote: off\.get\(c\.id\) \|\| ""/);
});

t('Team schedule: "can\'t work" days in team / month / day views + legend, from crew_availability_range', () => {
  assert.match(CS, /var availability = opts\.availability \|\| null;/);
  assert.match(CS, /cs-lg cs-lg-off/);
  assert.match(CS, /function setOff\(list\)/);
  assert.match(CS, /\(offN != null \? " cs-off" : ""\)/);
  assert.match(CAL, /availability: canStaff&&BPStore\.ops\.shifts&&BPStore\.ops\.shifts\.availability/);
  assert.match(r('public/crew-schedule.css'), /\.cs-offtag\{/);
});

t('Calendar: "Live today" tab (office roles) + unavailable-day conflicts', () => {
  assert.match(CAL, /id="cvTabLive" data-cv="live"/);
  assert.match(CAL, /<section id="liveToday" class="lb-wrap"/);
  assert.match(CAL, /cvLiveOk=!!\(!crewOnly&&window\.HelmLiveBoard&&BPStore\.ops&&BPStore\.ops\.live\)/);
  assert.match(CAL, /type:"unavailable"/);
  assert.match(CAL, /unavailable:"🚫"/);
});

t('Tasks & staff: progress card above Live status, Late chip, can\'t-work in the picker + warning, start-day clash check', () => {
  // R192: the event header carries ONE progress bar + the On-the-day Late box (ops-board.js); "late" comes from the shared
  // task-status.js rule, the same one /monitor uses
  const BRD = r('public/ops-board.js');
  assert.match(BRD, /"aria-valuenow": String\(sm\.pct\), "aria-label": sm\.pct \+ "% of tasks done"/);
  assert.match(BRD, /h\("h3", \{\}, \["Late - not started ", h\("span", \{ cls: "tc-n", text: String\(late\.length\) \}\)\]\)/);
  assert.match(BRD, /var late = ts\.filter\(function \(t\) \{ return TS\.isLate\(t, now\); \}\)/);
  assert.match(OPS, /<script src="task-status\.js\?v=\d+"><\/script>\n(<script src="event-plan\.js\?v=\d+"><\/script>\n)?(<script src="day-before\.js\?v=\d+"><\/script>\n)?<script src="ops-board\.js\?v=\d+"><\/script>/);
  assert.match(OPS, /⛔ approved day off/); assert.match(OPS, /⏳ asked off this day \(waiting for approval\)/);   // R187 (0370): pending vs approved
  assert.match(OPS, /async function loadOff\(\)/);
  assert.match(OPS, /BPStore\.calendar\.wouldClash\(\{date:\(when&&\$\("#as_when"\)\.value/);
});

t('Home: "Ongoing & upcoming today" card, mounted once, compact', () => {
  assert.match(DASH, /<section id="liveHome" class="lb-home" hidden/);
  assert.match(DASH, /HelmLiveBoard\.mountToday\(\$\("#liveHome"\), \{ compact: true, max: 4, hours: 24, title: "Ongoing & upcoming today" \}\)/);
  assert.match(DASH, /if \(liveHomeUI \|\|/);
});

console.log(`\nr174-event-day-board: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
