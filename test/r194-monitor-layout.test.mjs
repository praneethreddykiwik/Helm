// R194: Event-day monitor layout (owner: "organise this page properly, the header and all") - one header band shared with
// Tasks & Crew, tidy summary, segmented tabs, one-row filters (Filters button on a phone), time-first rows, wall screen.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); } };
const JS = read('public/monitor.js'), HTML = read('public/monitor.html'), CSS = read('public/monitor.css'), TOURS = read('public/page-tours.js');
const win = {};
vm.runInNewContext(read('public/task-status.js'), { window: win, Intl, Date, Math, Number, String, Object, Array, JSON, isFinite, isNaN, Infinity, Promise, setInterval() {}, clearInterval() {} });
vm.runInNewContext(JS, { window: win, document: { getElementById: () => null, readyState: 'complete', addEventListener() {} }, Intl, Date, Math, Number, String, Object, Array, JSON, isFinite, isNaN, Infinity, URL, URLSearchParams, setInterval() {}, localStorage: null });
const M = win.HelmMonitor;

await t('header band reuses the Tasks & Crew header (ops-board.css .tc-ev / .tc-times / .tc-btn), loaded before monitor.css', () => {
  assert.match(HTML, /<link rel="stylesheet" href="ops-board\.css\?v=\d+">\n<link rel="stylesheet" href="monitor\.css\?v=\d+">/);
  assert.match(HTML, /<div id="monApp" class="tc mon-app" hidden>/);
  assert.match(HTML, /<section class="tc-ev tc-card mon-ev" aria-labelledby="monTitle">/);
  assert.match(HTML, /<dl class="tc-times mon-times" id="monTimes"/);
  assert.match(HTML, /id="monOpenOps" class="tc-btn tc-primary"[^>]*>Open Tasks &amp; Crew</);
  assert.doesNotMatch(HTML, /mon-top|mon-pick"/, 'the old two-column top is gone');
});

await t('event switcher is the title: the real <select id="monEvent"> sits over the name (label + hint kept for screen readers)', () => {
  const pick = HTML.slice(HTML.indexOf('class="mon-evpick"'), HTML.indexOf('id="monSub"'));
  assert.match(pick, /<h2 id="monTitle"/); assert.match(pick, /<label class="tc-sr" for="monEvent">Switch event<\/label>/);
  assert.match(pick, /<select id="monEvent" class="mon-evpick-sel" aria-describedby="monEventHint"/);
  assert.match(HTML, /<span id="monEventHint" class="tc-sr">Today and the next 3 days first/);
  assert.match(CSS, /\.mon-evpick-sel\{position:absolute;[^}]*opacity:0/);
  assert.match(CSS, /\.mon-evpick:focus-within\{outline:2px solid/);
});

await t('page order: header -> summary -> Late panel -> tabs -> filters -> view + activity rail', () => {
  const at = (s) => { const i = HTML.indexOf(s); assert.ok(i > 0, s); return i; };
  const order = ['class="tc-ev tc-card mon-ev"', 'id="monSummary"', 'id="monAlerts"', 'id="monTabs"', 'id="monTools"', 'class="mon-grid"', 'id="monView"', 'id="monFeed"'].map(at);
  assert.deepEqual(order, order.slice().sort((a, b) => a - b));
  for (const id of ['monEvent', 'monSummary', 'monTabs', 'monView', 'monFeed', 'monQ', 'monWho', 'monSec', 'monSt', 'monSort', 'monOpenOps', 'monRefresh', 'monUpdated', 'monClear', 'monLeftN', 'monErr', 'monBoot'])
    assert.match(HTML, new RegExp('id="' + id + '"'), id);
});

await t('countdown: Event in N days / Tomorrow / was N days ago / on the day a live clock (studio day)', () => {
  const today = M._todayIso(), add = (n) => new Date(Date.parse(today + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
  assert.deepEqual([...M._countdown({ event_date: add(9) })], ['Event in', '9 days']);
  assert.deepEqual([...M._countdown({ event_date: add(1) })], ['Event', 'Tomorrow']);
  assert.deepEqual([...M._countdown({ event_date: add(-2) })], ['Event was', '2 days ago']);
  assert.equal(M._countdown({ event_date: today })[0], 'Now');
  assert.deepEqual([...M._countdown({})], ['Countdown', 'No date yet']);
  assert.match(JS, /dl\.getAttribute\("data-live"\) === "1"\) ck\.textContent = fmtClock/, 'the clock ticks with the "Updated" line');
  assert.match(JS, /\[e\.event_date \? fmtDayIso\(e\.event_date, true\) : "No event date yet", e\.venue, e\.guests \? e\.guests \+ " guests" : ""\]/);
});

await t('rows: time first (as on Tasks & Crew) - "No time" sits quietly in that column, late says "12 min late"', () => {
  assert.match(JS, /role: "listitem" \}\);\n    row\.appendChild\(timeCell\(t\)\);/);
  assert.match(JS, /if \(!t\.planned_start\) return h\("span", \{ cls: "mon-time is-none", title: "No start time set", text: "No time" \}\);/);
  assert.doesNotMatch(JS, /text: "No start time"/);
  assert.equal(M._lateWords(12), '12 min late'); assert.equal(M._lateWords(75), '1 h 15 min late'); assert.equal(M._lateWords(120), '2 h late');
  assert.match(CSS, /\.mon-row\{display:grid;grid-template-columns:76px minmax\(0,1fr\);grid-template-areas:"time main" "time st" "time acts"/);
  assert.match(CSS, /\.mon-row\{grid-template-columns:104px minmax\(0,1fr\) minmax\(190px,auto\) auto;grid-template-areas:"time main st acts"/);
});

await t('summary: big % + bar + status chips in one row on a wide screen, the other facts in one muted line', () => {
  assert.match(JS, /top\.appendChild\(counts\);/);
  assert.match(JS, /text: sm\.confirmed \+ " of " \+ sm\.people \+ " people confirmed" \}/);
  assert.match(CSS, /\.mon-facts>\*\+\*::before\{content:"·"/);
  assert.match(CSS, /\.mon-latest\{[^}]*text-overflow:ellipsis/);
  assert.match(CSS, /\.mon-summary\{position:sticky;top:var\(--m-top\);z-index:5\}/, 'sticky under the app bar, not behind it');
  assert.match(JS, /app\.style\.setProperty\("--mon-sum-h"/, 'the activity rail sticks just under the summary');
});

await t('filters: one row on a tablet / desktop; a phone folds the menus behind Filters (count), Clear only when something is on', () => {
  assert.match(HTML, /<button type="button" id="monFiltersBtn" class="tc-btn mon-filtersbtn" aria-expanded="false" aria-controls="monFilters">/);
  assert.match(CSS, /\.mon-filters\{display:none;/); assert.match(CSS, /\.mon-tools\.is-open \.mon-filters\{display:grid\}/);
  assert.match(CSS, /\.mon-filtersbtn\{display:none\}/);
  assert.match(JS, /\$\("#monClear"\)\.hidden = !\(n \|\| q\);/);
  assert.match(JS, /this\.setAttribute\("aria-expanded", open \? "true" : "false"\)/);
});

await t('tabs keep role=tab / aria-selected and look like the Tasks & Crew segmented control', () => {
  assert.match(HTML, /role="tablist" aria-label="Views" id="monTabs"/);
  assert.match(CSS, /\.mon-tab\[aria-selected="true"\]\{background:#fff/);
});

await t('wall screen: toggle (aria-pressed), bigger text, filters out of the way, full screen when allowed, remembered on this device', () => {
  assert.match(HTML, /id="monWall" class="tc-btn ghost mon-wallbtn" aria-pressed="false"/);
  assert.match(JS, /doc\.body\.classList\.toggle\("mon-wall", !!on\)/);
  assert.match(JS, /requestFullscreen\(\)\.catch\(function \(\) \{\}\)/);
  assert.match(JS, /LS_WALL = "helm\.monitor\.wall"/);
  assert.match(CSS, /body\.mon-wall \.mon-tools\{display:none\}/); assert.match(CSS, /body\.mon-wall \.mon-pct b\{font-size:52px\}/);
});

await t('still DOM-only and the same 30 s shared refresh; the tour names the switcher, filters and wall screen', () => {
  assert.doesNotMatch(JS, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
  assert.match(JS, /TS\.refresher\(function \(\) \{ if \(signedIn\(\)\) return loadTasks\(true\); \}, REFRESH_MS\);/);
  assert.match(TOURS, /\{ sel: "\.mon-evpick", title: "Pick the event"/);
  assert.match(TOURS, /title: "Wall screen"/); assert.match(TOURS, /behind the Filters button/);
});

console.log(`\nr194-monitor-layout: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
