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
const ctx = { sessionStorage: { x: null, getItem() { return this.x; }, setItem() {}, removeItem() { this.x = null; } } };
vm.runInNewContext(JS, { sessionStorage: ctx.sessionStorage, BPStore: { studioTimezone: () => 'Asia/Kolkata' }, window: win, document: { getElementById: () => null, readyState: 'complete', addEventListener() {} }, Intl, Date, Math, Number, String, Object, Array, JSON, isFinite, isNaN, Infinity, URL, URLSearchParams, setInterval() {}, localStorage: null });
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

// R250: header -> step strip -> summary -> Late panel -> the step's cards -> tabs -> chips + filters -> view + rail
await t('page order: header -> step strip -> summary -> Late panel -> tabs -> filters -> view + activity rail', () => {
  const at = (s) => { const i = HTML.indexOf(s); assert.ok(i > 0, s); return i; };
  const order = ['class="tc-ev tc-card mon-ev"', 'id="monWins"', 'id="monSummary"', 'id="monAlerts"', 'id="monPrep"', 'id="monTabs"', 'id="monTools"', 'id="monChips"', 'class="mon-grid"', 'id="monView"', 'id="monFeed"'].map(at);
  assert.deepEqual(order, order.slice().sort((a, b) => a - b));
  for (const id of ['monEvent', 'monSummary', 'monTabs', 'monView', 'monFeed', 'monQ', 'monWho', 'monSec', 'monChips', 'monSort', 'monOpenOps', 'monRefresh', 'monUpdated', 'monClear', 'monErr', 'monBoot'])
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
  assert.match(JS, /if \(!t\.planned_start\) return h\("span", \{ cls: "mon-time is-none", text: "No time" \}\);/);   // R250: no hover tooltip
  assert.doesNotMatch(JS, /text: "No start time"/);
  assert.equal(M._lateWords(12), '12 min late'); assert.equal(M._lateWords(75), '1 h 15 min late'); assert.equal(M._lateWords(120), '2 h late');
  assert.match(CSS, /\.mon-row\{display:grid;grid-template-columns:76px minmax\(0,1fr\);grid-template-areas:"time main" "time st" "time acts"/);
  assert.match(CSS, /\.mon-row\{grid-template-columns:96px minmax\(0,1fr\) auto;grid-template-areas:"time main acts" "time st acts"/, 'R250: two-line rows 768-1279px');
  assert.match(CSS, /\.mon-row\{grid-template-columns:104px minmax\(0,1fr\) minmax\(190px,auto\) auto;grid-template-areas:"time main st acts"/);
});

// R250 / R251: the summary follows the step: readiness + get set up the day before, one slim live strip Pre-event / On the event (the
// only sticky block), still open + hours once the event is over; the "Latest:" line is gone (the rail / Activity tab have it) and the rail no longer sticks
await t('summary: readiness the day before, a slim sticky live strip on the event day, still open + hours when it is over; no "Latest:" line', () => {
  assert.match(JS, /fact\("Assigned", r\.assigned \+ " of " \+ r\.total/); assert.match(JS, /fact\("Accepted", r\.accepted \+ " of " \+ r\.total/);
  assert.match(JS, /fact\("Late", String\(sm\.late\)/); assert.match(JS, /fact\("Checked in", ac\.checkedIn \+ " of " \+ ac\.people/); assert.match(JS, /fact\("Next", /);
  assert.match(JS, /fact\("Still open", String\(left\)/); assert.match(JS, /fact\("Hours checked in", /);
  assert.doesNotMatch(JS, /"Latest: "|--mon-sum-h|stickyOffset/);
  assert.match(CSS, /\.mon-app:is\(\[data-win="pre"\],\[data-win="onday"\]\) \.mon-summary\{position:sticky;top:var\(--m-top\);z-index:5/, 'sticky under the app bar, only on the event day');
  assert.doesNotMatch(CSS, /\.mon-side\{position:sticky/);
});
await t('step strip: three steps (Wrap-up is no tab), dot + "Now" on the current one, a tap only looks (studio time only)', () => {
  assert.match(HTML, /<nav class="mon-stp" id="monWins" aria-label="Where the event is">/);
  assert.equal((HTML.match(/<span class="mon-stp-now">Now<\/span>/g) || []).length, 3);
  assert.doesNotMatch(HTML + JS + CSS, /data-win="?(before|wrapup)"?|"before"\)/, 'the old keys are gone');
  assert.doesNotMatch(HTML, /id="monWrap"/);
  assert.doesNotMatch(HTML + JS + CSS, /monWinAway|monWinNote|Back to now|helm\.mon\.win/);   // R251: studio time only, nothing stored
  assert.match(JS, /b\.setAttribute\("aria-current", "step"\)/);
  assert.doesNotMatch(JS, /Picked by hand/);
  assert.match(CSS, /\.mon-stp-b\.is-now::before\{border-color:var\(--m-acc\);background:var\(--m-acc\)\}/);
  assert.match(CSS, /\.mon-stp-list\{[^}]*overflow-x:auto/);
});
await t('status chips filter in place (never switch the tab); no native hover tooltips on labelled controls', () => {
  assert.match(JS, /S\.st = S\.st === k \? "" : k; render\(\);/);
  assert.doesNotMatch(JS, /setTab\(c\[0\] === "done"/);
  assert.doesNotMatch(JS, /title: "(Show only|Open the (Activity|Check-in) view|Show this task here|Open the proof photo|Reassign, change)/);
  assert.doesNotMatch(HTML, /\stitle="/);
});

await t('filters: one row on a tablet / desktop; a phone folds the menus behind Filters (count), Clear only when something is on', () => {
  assert.match(HTML, /<button type="button" id="monFiltersBtn" class="tc-btn mon-filtersbtn" aria-expanded="false" aria-controls="monFilters">/);
  assert.match(CSS, /\.mon-filters\{display:none;/); assert.match(CSS, /\.mon-tools\.is-open \.mon-filters\{display:grid\}/);
  assert.match(CSS, /\.mon-filtersbtn\{display:none\}/);
  assert.match(JS, /\$\("#monClear"\)\.hidden = !\(n \|\| q \|\| S\.st\);/);
  assert.match(JS, /this\.setAttribute\("aria-expanded", open \? "true" : "false"\)/);
});

await t('tabs keep role=tab / aria-selected and look like the Tasks & Crew segmented control', () => {
  assert.match(HTML, /role="tablist" aria-label="Views" id="monTabs"/);
  assert.match(CSS, /\.mon-tab\[aria-selected="true"\]\{background:var\(--m-panel\)/);
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

// ---- R251: Day before / Pre-event / On the event, Wrap-up closed at the bottom ----
await t('R251 page order: the strip under the header; pre-event card then Wrap-up last, after the work', () => {
  const at = (x) => { const i = HTML.indexOf(x); assert.ok(i > 0, x); return i; };
  const o = ['id="monTitle"', 'id="monWins"', 'id="monSummary"', 'id="monRun"', 'id="monAlerts"', 'id="monIssues"', 'id="monPrep"', 'id="monDayBefore"', 'id="monLock"', 'id="monReady"', 'id="monFloor"', 'id="monWork"', 'id="monPreDone"', 'id="monWrapUp"'].map(at);
  assert.deepEqual(o, o.slice().sort((a, b) => a - b));
  assert.match(CSS, /\.mon-predone\{order:3\}\.mon-wrapup\{order:4\}/);
  assert.match(HTML, /event-steps\.css\?v=\d+/); assert.match(HTML, /event-steps\.js\?v=\d+/);
  assert.match(JS, /if \(pre\) ES\.renderPreDone\(\$\("#monPreDone"\), stepsCtx\(\)\)/); assert.match(JS, /EW\.render\(\$\("#monWrapUp"\), stepsCtx\(\)\)/);
  assert.match(JS, /var ES = window\.HelmEventSteps, EW = window\.HelmEventWrap/);
});
await t('R251 the step = the studio clock + the quote stage; a look at another step lasts until the clock moves on; over = On the event with Wrap-up as now', () => {
  const S = M._S;
  const iso = (n) => new Date(Date.parse(M._todayIso() + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
  const run = (e, pick) => { S.quote = 'q1'; S.tasks = []; S.rs = null; S.evInfo = { q1: e }; S.winAt = ''; M._setWin(); if (pick) { S.manualWin = pick; M._setWin(); } return [S.autoWin, S.win, S.manualWin]; };
  assert.deepEqual(run({ event_date: iso(5) }), ['daybefore', 'daybefore', null]);
  assert.deepEqual(run({ event_date: iso(0), stage: 'event_day' }), ['onday', 'onday', null]);
  assert.deepEqual(run({ event_date: iso(-3) }), ['wrapup', 'onday', null]);
  assert.deepEqual(run({ event_date: iso(-3), stage: 'settlement' }), ['wrapup', 'onday', null]);
  assert.deepEqual(run({ event_date: iso(5) }, 'daybefore'), ['daybefore', 'daybefore', null], 'a look at the real step is no pick');
  assert.deepEqual(run({ event_date: iso(5) }, 'pre'), ['daybefore', 'pre', 'pre']);
  S.manualWin = 'pre'; S.evInfo.q1.event_date = iso(0); S.evInfo.q1.stage = 'event_day'; M._setWin(); assert.deepEqual([S.win, S.manualWin], ['onday', null], 'a new step by the clock drops the look');
  S.quote = 'all'; M._setWin(); assert.deepEqual([S.autoWin, S.win, S.manualWin], ['onday', 'onday', null], 'all events: no steps');
  S.quote = null;
  assert.match(JS, /TS\.opsWindow\(S\.mode, \{ eventDate: e\.event_date, eventTime: e\.event_time, stage: e\.stage, now: Date\.now\(\), tz: tz\(\) \}\)/);
});
await t('R251 badge = the real step, never the one looked at: Planning / Pre-event / Event day - live / Event over / Complete', () => {
  const fn = JS.slice(JS.indexOf('function renderPill()'), JS.indexOf('/* R250: the step strip'));
  for (const w of ['"Planning"', '"Pre-event"', '"Event day - live"', '"Event over"', '"Complete"']) assert.ok(fn.includes(w), w);
  assert.match(fn, /var w = S\.autoWin/); assert.doesNotMatch(fn, /S\.win\b|manualWin/);
});
await t('R251 People and Work in step order with a done count; all events stay one list; hint to allocate pre-event first', () => {
  const fn = JS.slice(JS.indexOf('function byStep('), JS.indexOf('function viewStaff('));
  assert.match(fn, /if \(!single\(\)\) return draw\(list\);/); assert.match(fn, /TS\.WINDOWS\.forEach/); assert.match(fn, /TS\.bySteps\(S\.tasks, o\)/);
  assert.match(fn, /g\.done \+ " of " \+ g\.total \+ " done"/); assert.match(fn, /"Allocate pre-event work first - " \+ preLeft \+ " left"/);
  assert.match(JS, /byStep\(list, S\.tab === "work" \? viewWork : viewStaff\)/);
});
await t('R251 issues: the same read + log as Tasks & Crew, only with the Issues permission, only On the event', () => {
  assert.match(JS, /!S\.issView \|\| !single\(\) \|\| S\.win !== "onday"/);
  assert.match(JS, /S\.issEdit = S\.issView && !!\(await A\.canEditArea\("issues"\)\)/); assert.match(JS, /if \(S\.issEdit\) \{ var lg/);
  assert.match(JS, /BPStore\.issues\.add\(q, \{ kind: "issue", title: t, severity: sev\.value, owner: null \}\)/);
  assert.equal((JS.match(/BPStore\.issues\./g) || []).length, 1, 'no other issue write on this page');
});
await t('R251 buttons: theme accent, on-accent ink, the page id beats the shell link colour (no black control left)', () => {
  assert.match(CSS, /#monApp a\.tc-btn,#monDrawer a\.tc-btn\{color:var\(--tc-ink\);text-decoration:none\}/);
  assert.match(CSS, /#monApp \.tc-btn\.tc-primary,#monDrawer \.tc-btn\.tc-primary\{background:var\(--tc-acc\);[^}]*color:var\(--hb-acc-ink,#fff\)\}/);
  assert.doesNotMatch(CSS, /--m-black|background:var\(--m-ink\)|#monOpenOps/);
});
await t('R251 another event picked while the old one loads: never shown under the new name', () => {
  assert.match(JS, /if \(S\.quote !== q0\) return;/); assert.match(JS, /if \(S\.quote !== q0\) \{ S\.tasks = \[\]; loadTasks\(false\); \}/);
});

console.log(`\nr194-monitor-layout: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
