// R184: Event day monitor shows check-in / check-out + every update (0368 event_task_log + event_day_activity), and a
// "can't work" day carries its reason everywhere (worker page, Team calendar, assign warning, Conflicts, monitor).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); } };

const MIG = read('supabase/migrations/0368_r184_event_activity.sql');
const APPLY = read('supabase/APPLY-0368.sql');
const MF = read('supabase/migrations/MANIFEST');
const RUNALL = read('scripts/db-test/run-all.sh');
const RET = read('tests/db/trial-retention-0184.sql');
const API = read('public/store-api.js');
const MON = read('public/monitor.js'), MONH = read('public/monitor.html'), MONC = read('public/monitor.css');
const SELF = read('public/crew-self.js'), SCHED = read('public/crew-schedule.js'), CSS = read('public/crew-shifts.css');
const TOURS = read('public/page-tours.js');
const code = (s) => s.replace(/^\s*--.*$/gm, '');

const win = {};
// R192: monitor.js uses the shared status / late / escalation module (task-status.js), loaded first as on the page
vm.runInNewContext(readFileSync(new URL('../public/task-status.js', import.meta.url), 'utf8'), { window: win, Intl, Date, Math, Number, String, Object, Array, JSON, isFinite, isNaN, Infinity, Promise, setInterval() {}, clearInterval() {} });
vm.runInNewContext(MON, { window: win, document: { getElementById: () => null, readyState: 'complete', addEventListener() {} }, Intl, Date, Math, Number, String, Object, Array, JSON, isFinite, isNaN, Infinity, URL, URLSearchParams, setInterval() {}, localStorage: null });
const M = win.HelmMonitor;

await t('0368: one closed log table (RLS on, no grants, studio guards) + two never-blocking triggers', () => {
  assert.match(MIG, /create table if not exists public\.event_task_log \(/);
  assert.match(MIG, /alter table public\.event_task_log enable row level security;/);
  assert.match(MIG, /revoke all on table public\.event_task_log from authenticated/);
  assert.match(MIG, /tgname = 'zz_quote_org_match'/); assert.match(MIG, /tgname = 'zzz_studio_read_only'/);
  assert.match(MIG, /create trigger zzz_r368_task_log after insert or update on public\.event_tasks/);
  assert.match(MIG, /create trigger zzz_r368_checkin_log after insert or update on public\.crew_checkins/);
  // both trigger bodies swallow their own errors: the task / check-in change always goes through
  assert.equal((MIG.match(/exception when others then\s+null;/g) || []).length, 2);
  assert.doesNotMatch(code(MIG), /\bdrop\s+(table|function|policy|index|trigger)\b|\bdelete\s+from\b|\btruncate\b/i);
});

await t('0368: timeline is event_day_activity (never the older event_activity name), office of the same studio only', () => {
  assert.match(MIG, /create or replace function public\.event_day_activity\(p_quote uuid, p_limit integer default 200\)/);
  assert.doesNotMatch(MIG, /function public\.event_activity\(/);
  assert.match(MIG, /coalesce\(v_role, ''\) in \('crew', 'worker'\)/);
  assert.match(MIG, /q\.org_id = v_org and q\.deleted_at is null/);
  assert.match(MIG, /grant execute on function public\.event_day_activity\(uuid,integer\) to authenticated/);
  for (const src of ['public.event_task_log l', 'public.event_tasks t', 'public.crew_checkins k', 'public.staff_email_outbox e', 'public.staff_update_outbox u'])
    assert.ok(MIG.includes(src), 'timeline reads ' + src);
  assert.match(MIG, /not exists \(select 1 from public\.event_task_log l2 where l2\.task_id = t\.id and l2\.kind = s\.kind\)/, 'no doubles from step times');
});

await t('0368: editor-safe (ASCII, no apostrophes in comments), APPLY verbatim, MANIFEST, run-all, retention test re-applies it', () => {
  assert.ok(/^[\x00-\x7f]*$/.test(MIG), 'ASCII only');
  assert.ok(!MIG.split('\n').some((l) => /^\s*--/.test(l) && l.includes("'")), 'no apostrophe in a comment');
  assert.equal(APPLY.slice(APPLY.indexOf('begin;\n') + 7, APPLY.indexOf('\ncommit;\n')).trim(), MIG.trim());
  assert.match(APPLY, /^-- APPLY-0368 \(R184 [^\n]*\)\. Run on STAGING first, then production\. Safe to run twice\.\n/);
  assert.ok(MF.includes('forward  supabase/migrations/0368_r184_event_activity.sql'));
  assert.match(RUNALL, /R184-EVENT-ACTIVITY-0368: ALL PASS/);
  assert.match(RET, /\\ir \.\.\/\.\.\/supabase\/migrations\/0368_r184_event_activity\.sql/);
  assert.match(MIG, /'staff_links', ''member_presence'', ''event_task_log'''|''member_presence'', ''event_task_log''/);
});

await t('store: ops.live.activity -> event_day_activity, null before 0368; the older quote activity trail is untouched', () => {
  const line = API.split('\n').find((l) => l.includes('async activity(quoteId, limit)')) || '';
  assert.ok(line.includes('rpc("event_day_activity", { p_quote: quoteId, p_limit: limit || 200 })') && line.includes('if (rpcMissing(e)) return null'), line);
  assert.match(API, /activity: \(quoteId\) => \(mode === "supabase" \? rpc\("event_activity", \{ p_quote: quoteId \}\)/);
});

await t('monitor: Check-in and Activity tabs exist and are allowed', () => {
  assert.match(MONH, /data-tab="checkin" id="monTab-checkin"/); assert.match(MONH, /data-tab="activity" id="monTab-activity"/);
  assert.match(MON, /\/\^\(staff\|work\|status\|left\|checkin\|activity\)\$\//);
  assert.match(MON, /S\.tab === "checkin" \? viewCheckin\(list\)/);
  assert.match(MON, /if \(S\.tab === "activity"\) v\.appendChild\(viewActivity\(\)\)/);
  assert.doesNotMatch(MON, /innerHTML|insertAdjacentHTML/);
});

await t('monitor: attendance line, x of y checked in, late check-in, the can\u2019t-work reason; data from timesheet + availability + timeline', () => {
  assert.match(MON, /Checked in " \+ \(e\.inAt \? fmtClock\(e\.inAt\)/); assert.ok(MON.includes('"Checked out \u2014"'));
  assert.match(MON, /ac\.checkedIn \+ " of " \+ ac\.people \+ " checked in"/);
  assert.match(MON, /Late check-in/);
  assert.ok(MON.includes('Marked this day as can\u2019t work \u00b7 " + (off || "no reason given")'));
  assert.match(MON, /await Promise\.all\(\[loadSheet\(ids\), loadOff\(ids\), loadActivity\(ids\)[,\]]/);
  assert.match(MON, /BPStore\.ops\.shifts && BPStore\.ops\.shifts\.availability/);
  assert.match(MON, /BPStore\.ops\.live && BPStore\.ops\.live\.activity/);
});

await t('monitor: attendance logic - late when checked in after the first task start; checked out shows both times', () => {
  const S = M._S;
  S.tasks = [{ id: 't1', crew_id: 'c1', status: 'accepted', planned_start: '2026-11-17T10:00:00Z' }];
  S.sheet = { c1: { day: '2026-11-17', in: '15:50', out: '', inAt: '2026-11-17T10:20:00Z', outAt: null, late_min: 0 } };
  let a = M._attendance('c1');
  assert.equal(a.state, 'in'); assert.equal(a.late, true); assert.equal(a.lateMin, 20); assert.match(a.text, /Checked out \u2014/);
  S.sheet.c1 = { day: '2026-11-17', in: '15:20', out: '20:00', inAt: '2026-11-17T09:50:00Z', outAt: '2026-11-17T14:30:00Z', late_min: 0 };
  a = M._attendance('c1'); assert.equal(a.state, 'out'); assert.equal(a.late, false);
  assert.equal(M._attendance('nobody').state, 'none');
});

await t('monitor: every update has plain words and a filter group', () => {
  const A = (kind, detail, extra) => M.actText(Object.assign({ kind, name: 'Ravi', title: 'Receive guests', detail: detail || {} }, extra || {}));
  assert.equal(A('reassigned', { from: 'Ravi', to: 'Mala' }), '\u201cReceive guests\u201d moved from Ravi to Mala');
  assert.equal(A('accepted'), 'Ravi accepted \u201cReceive guests\u201d');
  assert.equal(A('rejected'), 'Ravi turned down \u201cReceive guests\u201d');
  assert.equal(A('completed'), 'Ravi finished \u201cReceive guests\u201d');
  assert.equal(A('check_in', { late_min: 12 }), 'Ravi checked in \u00b7 12 min late');
  assert.equal(A('check_out'), 'Ravi checked out');
  assert.match(A('email_sent', { email_kind: 'task_reminder' }), /^Reminder e-mail sent to Ravi/);
  assert.match(A('email_sent', { email_kind: 'task_update' }), /Your tasks were updated/);
  assert.match(A('time_changed', { from: null, to: '2026-11-17T10:00:00Z' }), /start time not set \u2192 /);
  const groups = ['assigned', 'reassigned', 'accepted', 'started', 'time_changed', 'check_in', 'email_sent', 'special_on', 'cancelled'].map(M.actGroup);
  assert.deepEqual(groups, ['work', 'work', 'reply', 'progress', 'time', 'checkin', 'email', 'special', 'special']);
  assert.match(MON, /"See all " \+ acts\.length \+ " updates"/);
});

await t('worker page: reason asked when marking, shown in a list, can be changed (max 120), "I can work" frees the day', () => {
  assert.match(SELF, /function askReason\(day, isWork, current\)/);
  assert.match(SELF, /Why can't you work\? \(optional - e\.g\. Family function/);
  assert.match(SELF, /\.slice\(0, 120\)/);
  assert.match(SELF, /"Days you can't work"/);
  assert.match(SELF, /a\.note \? "Change reason" : "Add a reason"/);
  assert.match(SELF, /setAvailability\(token, day, "unavailable", reason \|\| null\)/);
  assert.match(SELF, /"I can work"/);
  assert.match(CSS, /\.cs-offrow\{/);
});

await t('Team calendar: the tag shows the reason ("Can\u2019t work \u00b7 Family function"), tooltip says when none', () => {
  // R187 (0370): offTxt(note, max, pending) - a day still waiting for approval reads "Asked off (waiting)"
  assert.match(SCHED, /function offTxt\(note, max, pending\)/);
  assert.match(SCHED, /return lead \+ " \\u00b7 " \+ n;/);
  assert.equal((SCHED.match(/esc\(offTxt\(/g) || []).length, 3);
  assert.match(SCHED, /\(no reason given\)/);
  // summaries name each person with their reason
  assert.match(SCHED, /\(nameOf\[a\.crew_id\] \|\| "Someone"\) \+ \(a\.approval === "pending" \? " - asked, waiting for approval" : ""\) \+ \(a\.note \? " \(" \+ a\.note \+ "\)" : ""\)/);
  // the reason is shortened with an ellipsis, never cut mid-tag
  const offTxt = new Function(SCHED.match(/function offTxt\(note, max, pending\) \{[\s\S]*?\n    \}/)[0] + '; return offTxt;')();
  assert.equal(offTxt('', 20), 'Can\u2019t work');
  assert.equal(offTxt('Family function', 20), 'Can\u2019t work \u00b7 Family function');
  assert.equal(offTxt('A very long reason about a family trip', 12), 'Can\u2019t work \u00b7 A very long\u2026');
  assert.equal(offTxt('Exam', 20, true), 'Asked off (waiting) \u00b7 Exam');
});

await t('monitor: red LATE panel at the top (every late task: task, person, was due, how long ago, Nudge) + "Latest:" line', () => {
  assert.match(MONH, /<section id="monAlerts" class="mon-alerts" aria-label="Late tasks" role="region" hidden><\/section>/);
  assert.ok(MONH.indexOf('id="monAlerts"') > MONH.indexOf('id="monSummary"') && MONH.indexOf('id="monAlerts"') < MONH.indexOf('id="monTabs"'));
  assert.match(MON, /function renderAlerts\(now\)/); assert.match(MON, /renderAlerts\(now\);/);
  assert.match(MON, /stateOf\(t, now\)\.late/);
  assert.match(MON, /"was due " \+ fmtClock\(t\.planned_start\) \+ " \(" \+ ago\(t\.planned_start, now\) \+ "\)"/);
  assert.match(MON, /row\.appendChild\(actions\(t\)\);/, 'Open + Nudge on each late task');
  assert.ok(MON.includes('Latest: " + actText(latest) + " \u00b7 " + ago(latest.at)'));
  assert.match(MONC, /\.mon-alerts\{/);
});

await t('page tour: the monitor tour names the new Check-in and Activity tabs', () => {
  assert.match(TOURS, /Six ways to look/); assert.match(TOURS, /Check-in: who is on site, who checked out, who is late/);
  assert.match(MONC, /\.mon-tl-i\{/); assert.match(MONC, /\.mon-ci-row\{/);
});

console.log(`\nr184-checkin-activity-reasons: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
