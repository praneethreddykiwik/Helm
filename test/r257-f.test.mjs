// R257 f (owner, 25 Nov 2026: "remove the lock ... I want a checklist, like Mark as done, who did it"): the Day before / Pre-event checklist (0442),
// no event-day lock anywhere, and the small fixes beside it. Pure rules + a small fake DOM + wiring; the SQL runs in tests/db/r257-no-lock-checklist-0442.sql,
// the pages in a browser with stub data.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); } };
const plain = (x) => JSON.parse(JSON.stringify(x)), tick = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0)); };
const DB = read('public/day-before.js'), EPJS = read('public/event-plan.js'), TSJS = read('public/task-status.js'), ESJS = read('public/event-steps.js'), MON = read('public/monitor.js'), MONH = read('public/monitor.html'), BRD = read('public/ops-board.js'), OPS = read('public/ops.html'),
  API = read('public/store-api.js'), SQL = read('supabase/migrations/0442_r257_no_lock_checklist.sql'), APPLY = read('supabase/APPLY-0442.sql'), TC = read('public/task-clash.js');
let DOC;
class El {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.attrs = {}; this.childNodes = []; this.parentNode = null; this.ev = {}; this.hidden = false; this._t = null; const me = this;
    this.classList = { add(c) { if (!me.className.split(' ').includes(c)) me.className = (me.className + ' ' + c).trim(); } }; }
  get className() { return this.attrs.class || ''; } set className(v) { this.attrs.class = v; }
  get id() { return this.attrs.id || ''; } set id(v) { this.attrs.id = v; }
  get firstChild() { return this.childNodes[0] || null; }
  get textContent() { return this._t != null ? this._t : this.childNodes.map((c) => c.textContent).join(''); } set textContent(v) { this.childNodes = []; this._t = String(v); }
  get open() { return 'open' in this.attrs; } set open(v) { if (v) this.attrs.open = ''; else delete this.attrs.open; }
  setAttribute(k, v) { if (k === 'hidden') this.hidden = true; this.attrs[k] = String(v); } getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  appendChild(c) { this._t = null; c.parentNode = this; this.childNodes.push(c); return c; } removeChild(c) { this.childNodes = this.childNodes.filter((x) => x !== c); c.parentNode = null; return c; }
  contains(n) { while (n) { if (n === this) return true; n = n.parentNode; } return false; }
  addEventListener(e, f) { (this.ev[e] = this.ev[e] || []).push(f); } fire(e, o) { (this.ev[e] || []).forEach((f) => f(Object.assign({}, o))); }
  click() { this.fire('click'); } focus() { DOC.activeElement = this; }
  all() { return this.childNodes.flatMap((c) => c.all ? [c, ...c.all()] : []); }
}
const NOW = Date.parse('2026-11-24T04:30:00Z'), Q = 'q1', ME = 'Ananya';
function world(o = {}) {
  const body = new El('body'); DOC = { activeElement: body, body, hidden: false, createElement: (x) => new El(x), createTextNode: (s) => ({ textContent: s }), getElementById: (i) => body.all().find((n) => n.id === i) || null };
  const host = new El('section'); host.id = 'h'; body.appendChild(host);
  const writes = [], toasts = [], reads = { marks: 0, arr: 0 };
  const D = { marks: o.marks || {}, lines: o.lines || [], log: [] }, bk = [{ id: 'b1', vendor_id: 'v1', label: 'Catering', status: 'booked' }, { id: 'b2', vendor_id: 'v2', label: 'DJ', status: 'confirmed' }];
  const W = { document: DOC, Intl, Date, setTimeout, console, location: { pathname: '/monitor.html' }, BPUI: { confirm: async (m) => { writes.push(['confirm', m]); return true; }, friendlyError: (e) => String(e.message) },
    BPStore: { auth: { canView: async () => true, canEditArea: async (a) => !(o.deny || []).includes(a), canAssignTasks: async () => true },
      readiness: { check: async () => ({ ready: false, checks: [{ key: 'vendors', label: 'Vendors confirmed', critical: true, ok: false, detail: '1 booked, not confirmed' }, { key: 'menu', label: 'Menu locked', critical: true, ok: true, detail: 'locked' }, { key: 'briefing', label: 'Team briefed', critical: true, ok: false, detail: 'pending', signoff: 'briefing' }] }), setSignoff: async (...a) => { writes.push(['sign', ...a]); } },
      bookings: { list: async () => plain(bk), update: async (...a) => { writes.push(['booking', ...a]); } }, vendors: { listAll: async () => [{ id: 'v1', name: 'Annapurna', phone: '9848011111' }, { id: 'v2', name: 'Beat', phone: '' }] }, resources: { listNeeds: async () => [] },
      inventory: { layout: { needs: async () => ({ types: [{ layout_type: 'chair', label: 'Chair', objects: 100, seats: 100 }], items: [], unlinked: [] }) }, reservations: async () => [{ item_id: 'i1', qty: 5, status: 'reserved' }], checkouts: { list: async () => [] }, shortages: async () => [] },
      checklist: { list: async () => [] }, dayops: { list: async () => { reads.arr++; return [{ ref_id: 'b2', status: 'arrived' }]; } },
      ops: { dayPlan: { check: async (...a) => { writes.push(['check', ...a]); } }, listTasks: async () => [], listCrew: async () => [], planLock: {},
        checks: o.old ? { get: async () => null } : { get: async () => { reads.marks++; return plain(Object.assign({ can_edit: o.edit !== false }, D)); },
          mark: async (q, k, d, n) => { writes.push(['mark', k, d, n]); if (o.other) return { key: k, item: { done: true, by: 'Suresh', at: '2026-11-24T04:03:00Z' } }; D.marks[k] = { done: d, by: ME, at: new Date(NOW).toISOString() }; return { key: k, item: D.marks[k] }; },
          addLine: async (q, s, x, id) => { writes.push(['add', s, x, !!id]); D.lines.push({ id: 'l' + D.lines.length, step: s, title: x, by: ME, at: new Date(NOW).toISOString() }); return { id }; }, cancelLine: async (id) => { writes.push(['cancel', id]); D.lines = D.lines.filter((x) => x.id !== id); } } } } };
  W.window = W; W.globalThis = W; vm.createContext(W); [TSJS, EPJS, ESJS, DB].forEach((x) => vm.runInContext(x, W));
  const ctx = () => Object.assign({ plan: { can_edit: true, checks: {} }, tasks: o.tasks || [], quoteId: Q, eventDate: '2026-11-29', eventTime: '7:00 PM', tz: 'Asia/Kolkata', now: NOW, nameOf: (x) => x.assignee_name || '', toast: (m, k) => toasts.push([k, m]), sheet: { c1: { in: '09:00' } } }, o.ctx || {});
  const day = () => W.HelmDayBefore.render(host, ctx()), pre = () => W.HelmDayBefore.renderPre(host, ctx());
  return { W, host, day, pre, ctx, writes, toasts, reads, by: (id) => DOC.getElementById(id), row: (k) => { let n = DOC.getElementById('hdbT-' + k); while (n && n.tagName !== 'LI') n = n.parentNode; return n; }, text: () => host.textContent };
}
await t('1a a line Helm works out: Mark done is a stored tick with name and time, the fact stays, Undo, the booking never changes', async () => {
  const w = world(); w.day(); await tick(); assert.match(w.row('rd-vendors').textContent, /Vendors confirmed1 of 2 confirmedMark done/);
  w.by('hdbB-hdbMk-rd-vendors').click(); await tick(); assert.deepEqual(w.writes, [['mark', 'daybefore:rd-vendors', true, '1 vendor is not confirmed']]);
  assert.match(w.row('rd-vendors').textContent, /Marked done by Ananya, 10:00 AM, though 1 vendor is not confirmedUndo/); assert.equal(w.by('hdbMk-rd-vendors').attrs['aria-pressed'], 'true');
  w.by('hdbMk-vn-b1').click(); await tick(); assert.deepEqual(w.writes[1], ['mark', 'daybefore:vn-b1', true, 'the booking is not confirmed']); assert.ok(!w.writes.some((x) => x[0] === 'booking'));
  w.by('hdbB-hdbMk-rd-vendors').click(); await tick(); assert.deepEqual(w.writes[2].slice(0, 3), ['mark', 'daybefore:rd-vendors', false]); assert.match(w.row('rd-vendors').textContent, /Mark done/);
});
await t('1b a line that is true by itself says Auto and has nothing to press; somebody else\'s earlier tick stays theirs', async () => {
  const w = world({ other: true }); w.day(); await tick(); assert.match(w.row('rd-menu').textContent, /Auto/); assert.equal(w.by('hdbB-hdbMk-rd-menu'), null); assert.equal(w.by('hdbMk-rd-menu'), null);
  w.by('hdbB-hdbMk-rd-vendors').click(); await tick(); assert.match(w.row('rd-vendors').textContent, /Marked done by Suresh, 9:33 AM/);
});
await t('1c the count holds every line; Show (Do these first) and Mark done there', async () => {
  const w = world(); w.day(); await tick(); const m = /^(\d+) of (\d+) done - (\d+) to go$/.exec(w.by('hTot').textContent); assert.ok(m); assert.equal(+m[1] + +m[3], +m[2]);
  assert.ok(w.by('hdbTop-hdbMk-vn-b1')); w.by('hdbTop-show-vn-b1').click(); assert.equal(DOC.activeElement.id, 'hdbT-vn-b1'); assert.match(w.row('vn-b1').className, /is-flash/); assert.match(w.row('vn-b1').textContent, /Phone 9848011111/);
  w.by('hdbTop-hdbMk-vn-b1').click(); await tick(); const m2 = /^(\d+) of/.exec(w.by('hTot').textContent); assert.equal(+m2[1], +m[1] + 1);
});
await t('1d Team briefed = the Readiness sign-off, with the name beside it; without that right only the stored tick', async () => {
  const w = world(); w.day(); await tick(); w.by('hdbB-hdbMk-rd-briefing').click(); await tick(); assert.deepEqual(w.writes[0], ['sign', Q, 'briefing', true]); assert.deepEqual(w.writes[1].slice(0, 3), ['mark', 'daybefore:rd-briefing', true]);
  const x = world({ deny: ['ready'] }); x.day(); await tick(); x.by('hdbB-hdbMk-rd-briefing').click(); await tick(); assert.deepEqual(x.writes.map((z) => z[0]), ['mark']);
});
await t('1e your own lines: added once, ticked, taken off (cancel, asked first); < > and empty are refused', async () => {
  const w = world(); w.day(); await tick(); const f = () => w.host.all().find((n) => n.tagName === 'FORM'), type = (v) => { const i = w.by('hdbOwn'); i.value = v; i.fire('input'); f().fire('submit', { preventDefault() {} }); };
  type('  '); type('<b>'); await tick(); assert.deepEqual(w.writes, []); type(' Return  gifts collected '); await tick(); assert.deepEqual(w.writes[0].slice(0, 3), ['add', 'daybefore', 'Return gifts collected']); assert.equal(w.by('hdbOwn').value, '');
  w.by('hdbMk-own:l0').click(); await tick(); assert.equal(w.writes[1][1], 'daybefore:own:l0'); assert.match(w.row('own:l0').textContent, /Done by Ananya, 10:00 AM/);
  w.by('hdbMore-own:l0').click(); w.by('hdbOwnX-l0').click(); await tick(); assert.deepEqual(w.writes.slice(2).map((x) => x[0]), ['confirm', 'cancel']); assert.equal(w.row('own:l0'), null);
  const c = world({ ctx: { closed: true } }); c.day(); await tick(); assert.equal(c.host.all().some((n) => n.tagName === 'FORM'), false);
});
await t('1f a viewer reads: no Mark done, no form; before 0442 the list says so and the 11 ticks still work', async () => {
  const v = world({ edit: false, ctx: { plan: { can_edit: false, checks: {} } }, deny: ['ready', 'logistics'] }); v.day(); await tick(); assert.equal(v.host.all().filter((n) => /hdb-tk/.test(n.className)).length, 0); assert.match(v.text(), /Someone who can give out work/);
  const o = world({ old: true }); o.day(); await tick(); assert.equal(o.by('hdbMk-rd-vendors'), null); assert.match(o.text(), /need database update 0442/); o.by('epChk-power').click(); await tick(); assert.deepEqual(o.writes, [['check', Q, 'power', true]]);
  const p = world({ old: true }); p.pre(); await tick(); assert.match(p.text(), /Ticks on this list and lines of your own need database update 0442/); assert.equal(p.W.HelmDayBefore.openLines(Q, 'pre'), null);
});
const PRE = [{ id: 'a', category: 'Decor', title: 'Stage', status: 'completed', crew_id: 'c1', planned_start: '2026-11-29T05:30:00Z' }, { id: 'b', category: 'Catering', title: 'Counters', status: 'assigned', crew_id: 'c2', planned_start: '2026-11-29T06:30:00Z' }, { id: 'd', category: 'Service', title: 'Dinner service', status: 'assigned', crew_id: 'c2', planned_start: '2026-11-29T15:00:00Z' }, { id: 'e', category: 'AV', title: 'x', status: 'cancelled', crew_id: 'c2', planned_start: '2026-11-29T06:30:00Z' }];
await t('2a Pre-event: crew, vendors, stock, one line per department with pre-event tasks, the checks', async () => {
  const w = world({ tasks: PRE, ctx: { now: Date.parse('2026-11-29T06:00:00Z') } }); w.pre(); await tick();
  assert.match(w.row('crew').textContent, /Crew checked in1 of 2 checked in/); assert.match(w.row('vendors').textContent, /Vendors arrived1 of 2 arrived/); assert.match(w.row('stock').textContent, /0 of 1 items given out/);
  assert.match(w.row('dep-decor').textContent, /Decor set upAuto1 of 1 task done/); assert.match(w.row('dep-catering').textContent, /Catering set up0 of 1 task done/); assert.equal(w.row('dep-service'), null); assert.equal(w.row('dep-av'), null);
  for (const k of ['safety', 'soundlight', 'seating', 'food', 'walk', 'briefed']) assert.ok(w.row(k), k);
  w.by('hdbMk-safety').click(); await tick(); assert.deepEqual(w.writes, [['mark', 'pre:safety', true, null]]); w.by('hdbMk-crew').click(); await tick(); assert.match(w.row('crew').textContent, /Marked done by Ananya.*though 1 person is not checked in/);
});
await t('2b "Mark pre-event complete" lists the open lines (only those a person ticks), says nothing when they are not known', async () => {
  const w = world({ tasks: PRE, ctx: { now: Date.parse('2026-11-29T06:00:00Z') } }); w.pre(); await tick(); const P = w.W.HelmEventSteps._pure, c = { quoteId: Q, quote: { eventDate: '2026-11-29', eventTime: '7:00 PM' }, tasks: PRE, tz: 'Asia/Kolkata' };
  const s = P.preSummary(c); assert.ok(s.lines.includes('Safety and power')); assert.ok(!s.lines.some((x) => /set up|Crew checked|Vendors/.test(x))); assert.ok(P.preLines(s).some((l) => /checklist lines not ticked: Safety and power/.test(l[1])));
  assert.match(P.confirmPre('X', s), /checklist lines not ticked/); assert.equal(P.preSummary(Object.assign({}, c, { quoteId: 'other' })).lines, undefined);
});
await t('3 both pages: the checklist is the first thing of Day before and Pre-event; what is below is closed', () => {
  const at = (x) => { const i = MONH.indexOf('id="' + x + '"'); assert.ok(i > 0, x); return i; };
  for (const x of ['monSummary', 'monRun', 'monAlerts', 'monPrep', 'monReady', 'monFloor', 'monWork']) assert.ok(at('monDayBefore') < at(x) && at('monPreList') < at(x), x);
  assert.match(BRD, /daybefore: \["tcDayBefore"/); assert.match(BRD, /pre: \["tcPreList", "tcCheckin"/); assert.match(BRD, /DB\.renderPre\(pHost, planCtx\(\)\)/); assert.match(MON, /DB\.renderPre\(ph, planCtx\(\)\)/); assert.match(OPS, /id="tcPreList"/);
  assert.match(MON, /var PREP = \{ open: false \}/); assert.match(read('public/day-before.css'), /\.hdb-row\.is-flash/);
});
await t('4 the small ones: ready by, sent back, wrap-up, the same task twice, latest, order of work, heading, after Ready by, floor plan check, group dialog', () => {
  assert.match(BRD, /EPx\.readyAt\(S\.plan, evDate\(\), String\(\(G\(\)\.quote \|\| \{\}\)\.eventTime/);
  assert.match(MON, /"Sent back" \+ \(t\.verify_note \? ": "/);
  const W = { console }; W.window = W; W.globalThis = W; vm.createContext(W); [TSJS, EPJS, ESJS, TC].forEach((x) => vm.runInContext(x, W)); const P = W.HelmEventWrap._pure, T = W.HelmTaskStatus;
  const ev = { quote: { eventDate: '2026-11-29', eventTime: '7:00 PM' }, tz: 'Asia/Kolkata', tasks: [{ id: 'a', status: 'completed', crew_id: 'c', title: 'Stage', planned_start: '2026-11-29T05:30:00Z' }] };
  const r = P.progress(ev, { issues: [] }); assert.deepEqual([r.done, r.total], [2, 2], 'All done + None open count');
  const K = W.HelmTaskClash; assert.deepEqual(plain(K.already([{ id: 1, crew_id: 'c', title: 'Build  stage' }], { crew: 'c' }, ['build stage', 'x'])), ['build stage']); assert.equal(K.already([{ id: 1, crew_id: 'c', title: 'A', status: 'cancelled' }], { crew: 'c' }, ['A']).length, 0); assert.equal(K.already([{ id: 1, crew_id: 'c', title: 'A' }], { crew: 'c' }, ['A'], [1]).length, 0); assert.equal((OPS.match(/HelmTaskClash\.askSame\(/g) || []).length, 3);
  const acts = [{ kind: 'started', task_id: 't', at: '2026-11-29T06:00:00Z' }, { kind: 'completed', task_id: 't', at: '2026-11-29T05:00:00Z' }], wc = T.withChecks(acts, [{ id: 't', title: 'Stage', verify_status: 'rejected', verified_at: '2026-11-29T06:00:00Z', verify_note: 'Left side is not level', assignee_name: 'Ravi' }]);
  assert.deepEqual(plain(wc.map((a) => a.kind)), ['sent_back', 'completed']); assert.equal(T.actText({ kind: 'sent_back', title: 'Stage', name: 'Ravi', detail: { by: 'Asha', note: 'Not level' } }), '“Stage” sent back by Asha: Not level (Ravi)'); assert.equal(T.actText({ kind: 'approved', title: 'Stage', detail: { by: 'Asha' } }), '“Stage” approved by Asha');
  const logged = [{ kind: 'sent_back', task_id: 't', at: '2026-11-29T06:00:00Z' }]; assert.equal(T.withChecks(logged, [{ id: 't', verify_status: 'rejected', verified_at: '2026-11-29T06:00:00Z' }]).length, 1, 'never twice');
  assert.match(BRD, /otxt = ot\.hold \?/); assert.match(BRD, /people: "Tasks by person"/); assert.doesNotMatch(BRD, /once the latest database update is in/); assert.match(BRD, /function freshStrip\(\)/);
  const o = { plan: {}, eventDate: '2026-11-29', eventTime: '9:00 PM', tz: 'Asia/Kolkata' }; assert.equal(W.HelmEventPlan.afterReady({ status: 'assigned', title: 'Build stage', step: 'pre', planned_start: '2026-11-29T15:00:00Z' }, o), 'Starts after Ready by 8:00 PM'); assert.equal(W.HelmEventPlan.afterReady({ status: 'assigned', title: 'Build stage', step: 'pre', planned_start: '2026-11-29T13:00:00Z' }, o), '');
  assert.match(API, /key: "layout", label: "Floor plan saved", critical: true/); assert.match(read('public/event-group-picker.js'), /off: "Clients can't join the team group"/);
});
await t('5 SQL 0442: additive, pinned, kept bodies, studio checks, no session state, the one-line switch, the check rows', () => {
  const code = SQL.replace(/--[^\n]*/g, ''); assert.ok(/^[\x00-\x7f]*$/.test(SQL)); assert.ok(!/\b(drop\s+(table|column|function|policy|trigger)|truncate|delete\s+from|create\s+temp)\b/i.test(code)); assert.ok(!/^\\/m.test(APPLY));
  assert.equal((code.match(/security definer/g) || []).length, (code.match(/security definer set search_path = ''/g) || []).length);
  for (const f of ['_r397_locked', '_r397_guard', 'event_plan_lock_get', 'event_plan_lock_set', 'event_day_check_set', 'crew_day_status']) assert.ok(code.includes("('" + f + "'"), f + ' kept');
  assert.match(SQL, /_r442_lock_on\(\) returns boolean language sql stable set search_path = '' as 'select true'/); assert.match(code, /current_org_id\(\)/); assert.match(code, /_r396_event\(p_quote\)/); assert.match(code, /has_area\('staff', 'view'\)/);
  assert.ok(APPLY.includes(SQL.trimEnd())); assert.match(APPLY, /\nbegin;\n/); assert.match(APPLY, /\ncommit;\n$/); assert.match(read('supabase/migrations/MANIFEST'), /\nforward  supabase\/migrations\/0442_r257_no_lock_checklist\.sql\n/); assert.match(read('scripts/db-test/run-all.sh'), /R257-NO-LOCK-CHECKLIST-0442: ALL PASS \\\(34\/34\\\)/);
  assert.match(SQL.trim(), /\) c\("check", ok\);$/);
  for (const f of ['event_checks_get', 'event_check_mark', 'event_check_line_add', 'event_check_line_cancel']) assert.ok(API.includes('"' + f + '"'), f);
});
console.log('\nr257 f: ' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
