// R181: Event-day monitor page (monitor.html / monitor.js / monitor.css) - pure logic + wiring checks.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); } };

const JS = read('public/monitor.js'), HTML = read('public/monitor.html'), CSS = read('public/monitor.css');
// load the module without a DOM: it must only export HelmMonitor (the page code waits for #monApp)
const win = {};
vm.runInNewContext(JS, { window: win, document: { getElementById: () => null, readyState: 'complete', addEventListener() {} }, Intl, Date, Math, Number, String, Object, Array, JSON, isFinite, isNaN, Infinity, URL, URLSearchParams, setInterval() {}, localStorage: null });
const M = win.HelmMonitor;
const NOW = Date.parse('2026-11-16T09:00:00Z');
const ago = (min) => new Date(NOW - min * 60000).toISOString();
const later = (min) => new Date(NOW + min * 60000).toISOString();

await t('module loads without a page and exports the pure helpers', () => {
  assert.ok(M && typeof M.stateOf === 'function' && typeof M.summarize === 'function' && typeof M.leftover === 'function');
});

await t('status model: assigned = waiting, in_progress = started, completed = done, no person = no one yet', () => {
  assert.equal(M.stateOf({ status: 'assigned', crew_id: 'c1' }, NOW).key, 'waiting');
  assert.equal(M.stateOf({ status: 'assigned' }, NOW).key, 'unassigned');
  assert.equal(M.stateOf({ status: 'accepted', crew_id: 'c1' }, NOW).key, 'accepted');
  assert.equal(M.stateOf({ status: 'in_progress', crew_id: 'c1' }, NOW).key, 'started');
  assert.equal(M.stateOf({ status: 'completed', crew_id: 'c1' }, NOW).key, 'done');
  assert.equal(M.stateOf({ status: 'rejected', crew_id: 'c1' }, NOW).key, 'rejected');
});

await t('late = waiting or accepted with a start time already passed (started / done never late)', () => {
  assert.equal(M.stateOf({ status: 'assigned', crew_id: 'c', planned_start: ago(5) }, NOW).late, true);
  assert.equal(M.stateOf({ status: 'accepted', crew_id: 'c', planned_start: ago(5) }, NOW).late, true);
  assert.equal(M.stateOf({ status: 'accepted', crew_id: 'c', planned_start: later(5) }, NOW).late, false);
  assert.equal(M.stateOf({ status: 'in_progress', crew_id: 'c', planned_start: ago(30) }, NOW).late, false);
  assert.equal(M.stateOf({ status: 'completed', crew_id: 'c', planned_start: ago(30) }, NOW).late, false);
});

await t('summary: counts, % done, people confirmed, next due, first late; cancelled ignored', () => {
  const ts = [
    { id: 1, status: 'completed', crew_id: 'a', title: 'A' },
    { id: 2, status: 'in_progress', crew_id: 'a', title: 'B' },
    { id: 3, status: 'assigned', crew_id: 'b', title: 'C', planned_start: ago(10) },
    { id: 4, status: 'accepted', crew_id: 'c', title: 'D', planned_start: later(20) },
    { id: 5, status: 'cancelled', crew_id: 'b', title: 'X' },
  ];
  const s = M.summarize(ts, NOW);
  assert.equal(s.total, 4); assert.equal(s.done, 1); assert.equal(s.started, 1); assert.equal(s.waiting, 1); assert.equal(s.accepted, 1);
  assert.equal(s.late, 1); assert.equal(s.pct, 25);
  assert.equal(s.people, 3); assert.equal(s.confirmed, 2);
  assert.equal(s.next.title, 'D'); assert.equal(s.firstLate.title, 'C');
});

await t('leftover: not done, late first, then by start time, no-time last', () => {
  const ts = [
    { id: 1, status: 'accepted', crew_id: 'a', title: 'later', planned_start: later(60) },
    { id: 2, status: 'assigned', crew_id: 'a', title: 'late', planned_start: ago(5) },
    { id: 3, status: 'completed', crew_id: 'a', title: 'done' },
    { id: 4, status: 'assigned', crew_id: 'a', title: 'notime' },
    { id: 5, status: 'accepted', crew_id: 'a', title: 'soon', planned_start: later(5) },
    { id: 6, status: 'cancelled', title: 'gone' },
  ];
  assert.deepEqual(M.leftover(ts, NOW).map((x) => x.title), ['late', 'soon', 'later', 'notime']);
});

await t('after-midnight tasks say which night they belong to', () => {
  const s = M.fmtWhen('2026-11-28T20:30:00Z');   // 02:00 IST on 29 Nov (studio time zone falls back to the device; label must exist)
  assert.ok(typeof s === 'string' && s.length > 5);
  assert.match(JS, /night of/);
});

await t('page: tabs By staff / By work / By status / Leftover, picker, summary, filters, feed', () => {
  for (const id of ['monEvent', 'monSummary', 'monTabs', 'monView', 'monFeed', 'monQ', 'monWho', 'monSec', 'monSt', 'monSort', 'monOpenOps', 'monRefresh', 'monUpdated'])
    assert.match(HTML, new RegExp('id="' + id + '"'), id);
  for (const tab of ['By staff', 'By work', 'By status', 'Leftover']) assert.ok(HTML.includes(tab), tab);
  assert.match(HTML, /role="tablist"/);
});

await t('safety: no inline script, no HTML-string sinks in monitor.js (DOM + textContent only)', () => {
  assert.doesNotMatch(HTML.replace(/<script src=[^>]*><\/script>/g, ''), /<script>/);
  assert.doesNotMatch(JS, /innerHTML|insertAdjacentHTML|document\.write|outerHTML/);
});

await t('gate + data: Staff view required, only existing read paths, nudge only with Staff edit', () => {
  assert.match(JS, /requireView\("staff"\)/);
  assert.match(JS, /canEditArea\("staff"\)/);
  assert.match(JS, /BPStore\.ops\.listTasks\(/);
  assert.match(JS, /BPStore\.ops\.live\.today\(72\)/);
  assert.match(JS, /S\.canEdit && t\.crew_id/);
  assert.match(JS, /REFRESH_MS = 30000/);
  assert.match(JS, /doc\.hidden/);   // no polling in a hidden tab
});

await t('wiring: shell page list, nav item gated on Staff, routes, noindex headers, tour, links from live cards', () => {
  assert.match(read('public/shell-proto.js'), /monitor: 1/);
  const sb = read('public/shell-b.js');
  assert.match(sb, /\["insights", "Event day", "monitor\.html", "monitor"\]/);
  assert.match(sb, /GATE_AREA = \{ monitor: "staff" \}/);
  assert.match(sb, /can\(GATE_AREA\[k\] \|\| k\)/);
  const vj = read('vercel.json');
  assert.match(vj, /"source": "\/\(\[a-z0-9-\]\+\)\/monitor"/);
  assert.match(vj, /\|media\|monitor\|nurture\|/);
  assert.match(read('public/_headers'), /\n\/monitor\n  X-Robots-Tag: noindex/);
  assert.match(read('public/page-tours.js'), /"monitor\.html": \[/);
  const lb = read('public/live-board.js');
  assert.match(lb, /monitor\.html\?quote=/);
  assert.match(lb, /Open full monitor/);
});

await t('responsive css: phone first, kanban scrolls, side feed only on wide screens, print hides controls', () => {
  assert.match(CSS, /@media \(min-width:720px\)/);
  assert.match(CSS, /@media \(min-width:1100px\)/);
  assert.match(CSS, /\.mon-board\{[^}]*overflow-x:auto/);
  assert.match(CSS, /@media print/);
});

console.log(`\nr181-event-day-monitor: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
