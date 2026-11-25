// R251: public/event-steps.js - "Mark pre-event complete" (HelmEventSteps) and the closed-by-default Wrap-up (HelmEventWrap).
//   1 pure: what is still open, words, gate, stock parity with stock-flow.js, vendors, crew, rows, summary
//   2 behaviour on a small fake DOM: closed by default + no read until opened, no redraw when nothing changed, permissions,
//     refused reads hidden, the stage moves only after a confirm and only through setStageGuided, double click, errors
//   3 safety: no HTML strings, no inline style, no money, no write calls except setStageGuided; CSS theme tokens
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); } };
const JS = read('public/event-steps.js'), CSS = read('public/event-steps.css'), TSJS = read('public/task-status.js');
const SF = createRequire(import.meta.url)(new URL('../public/stock-flow.js', import.meta.url).pathname);
const plain = (x) => JSON.parse(JSON.stringify(x));

/* ---- a very small DOM ---- */
class Cls { constructor(n) { this.n = n; } list() { return (this.n.attrs.class || '').split(/\s+/).filter(Boolean); } add(...a) { const s = new Set(this.list()); a.forEach((x) => s.add(x)); this.n.attrs.class = [...s].join(' '); }
  toggle(c, on) { const s = new Set(this.list()); on ? s.add(c) : s.delete(c); this.n.attrs.class = [...s].join(' '); } contains(c) { return this.list().includes(c); } }
let DOC;
class El {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.attrs = {}; this.childNodes = []; this.parentNode = null; this.ev = {}; this.hidden = false; this._t = null; this.classList = new Cls(this); }
  get className() { return this.attrs.class || ''; } set className(v) { this.attrs.class = v; }
  get id() { return this.attrs.id || ''; } set id(v) { this.attrs.id = v; }
  get firstChild() { return this.childNodes[0] || null; }
  get textContent() { return this._t != null ? this._t : this.childNodes.map((c) => c.textContent).join(''); } set textContent(v) { this.childNodes = []; this._t = String(v); }
  get open() { return 'open' in this.attrs; } set open(v) { if (v) this.attrs.open = ''; else delete this.attrs.open; }
  setAttribute(k, v) { if (k === 'hidden') this.hidden = true; this.attrs[k] = String(v); } getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  appendChild(c) { this._t = null; c.parentNode = this; this.childNodes.push(c); return c; } removeChild(c) { this.childNodes = this.childNodes.filter((x) => x !== c); c.parentNode = null; return c; }
  contains(n) { while (n) { if (n === this) return true; n = n.parentNode; } return false; }
  addEventListener(e, f) { (this.ev[e] = this.ev[e] || []).push(f); } fire(e, o) { (this.ev[e] || []).forEach((f) => f(Object.assign({ detail: 1 }, o))); }
  focus() { DOC.activeElement = this; }
  all() { return this.childNodes.flatMap((c) => c.all ? [c, ...c.all()] : []); }
  querySelector(s) { const m = /^\[data-key="(.*)"\]$/.exec(s); return this.all().find((n) => n.attrs['data-key'] === m[1]) || null; }
}
const txt = (s) => ({ textContent: s });
const find = (h, f) => h.all().filter(f);
const btn = (h, k) => find(h, (n) => n.attrs['data-key'] === k)[0];
const tick = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0)); };

function world(o = {}) {
  DOC = { createElement: (x) => new El(x), createTextNode: txt, activeElement: null, getElementById: () => null };
  const calls = [], can = Object.assign({ vendors: true, inventory: true, plan: true, staff: true, issues: true, settlement: true, closure: true, command: true }, o.can);
  const log = (n, r) => (...a) => { calls.push([n, ...a]); if (r instanceof Error) return Promise.reject(r); return Promise.resolve(typeof r === 'function' ? r(...a) : r); };
  const W = { document: DOC, location: { pathname: o.path || '/monitor' }, BPUI: { confirm: log('confirm', o.confirm === undefined ? true : o.confirm), friendlyError: (e, x) => 'Couldn’t ' + x.action + ': ' + e.message, toast: log('toast') },
    BPStore: {
      auth: { canView: async (a) => !!can[a], canEditArea: async (a) => a === 'quotes' && o.quotesEdit !== false, role: async () => o.role || 'manager', handleAuthError: log('handleAuthError', o.authHandled || false) },
      quotes: { stageBlockers: log('stageBlockers', o.blockers || []), setStageGuided: log('setStageGuided', o.move === undefined ? ((id, s) => ({ stage: s })) : o.move) },
      bookings: { list: log('bookings', o.bookings || []) }, inventory: { reservations: log('reservations', o.res || []), checkouts: { list: log('checkouts', o.cos || []) } },
      checklist: { list: log('checklist', o.checklist || []) }, issues: { list: log('issues', o.issues || []) }, dayops: { list: log('dayops', o.arrivals || []) }, ops: { shifts: { timesheet: log('timesheet', o.timesheet || null) } } } };
  const g = { window: W, Intl, Date, Math, Number, String, Object, Array, JSON, isFinite, isNaN, Infinity, Promise, setInterval() {}, clearInterval() {}, encodeURIComponent };
  vm.runInNewContext(TSJS, g); vm.runInNewContext(JS, g);
  const host = new El('section'); host.id = 'hostX';
  return { W, host, calls, n: (k) => calls.filter((c) => c[0] === k).length };
}
const EV = '2026-11-29', tz = 'Asia/Kolkata', NOW = Date.parse('2026-11-29T05:00:00Z');
const TASKS = [
  { id: 'a', title: 'Stage set-up', status: 'completed', crew_id: 'c1', planned_start: '2026-11-29T03:30:00Z' },
  { id: 'b', title: 'Sound check', status: 'assigned', crew_id: 'c2', planned_start: '2026-11-29T06:30:00Z' },
  { id: 'c', title: 'Flowers', status: 'unassigned', planned_start: '2026-11-29T07:30:00Z' },
  { id: 'd', title: 'Lights', status: 'rejected', crew_id: 'c3', planned_start: '2026-11-29T07:30:00Z' },
  { id: 'e', title: 'Load truck', status: 'accepted', crew_id: 'c1', planned_start: '2026-11-28T10:00:00Z' },
  { id: 'f', title: 'Dinner service', status: 'assigned', crew_id: 'c4', planned_start: '2026-11-29T14:30:00Z' },
  { id: 'g', title: 'Old one', status: 'cancelled' }];
const CTX = (o) => Object.assign({ quoteId: 'q1', quote: { code: '11292026-01', title: 'Wedding', status: 'confirmed', stage: 'ready', eventDate: EV, eventTime: '7:00 PM' }, tasks: TASKS, autoWin: 'pre', win: 'pre', tz, now: NOW, nameOf: (x) => x.crew_id || '' }, o);
const base = world(), PS = base.W.HelmEventSteps._pure, PW = base.W.HelmEventWrap._pure;

await t('1a what is still open before guests arrive', () => {
  const s = PS.preSummary(CTX());
  assert.deepEqual([s.pre.length, s.day.length, s.unassigned, s.turned, s.waiting, s.checkedIn, s.total], [3, 1, 1, 1, 1, null, 4]);
  assert.equal(PS.preLines(PS.preSummary(CTX({ tasks: [TASKS[0]] }))).length, 0, 'all done = nothing listed');
  const none = PS.preSummary(CTX({ sheet: {} })); assert.equal(none.checkedIn, 0);
  assert.match(PS.preLines(none).map((l) => l[1]).join('|'), /Nobody has checked in yet \(2 people expected\)/);
  assert.match(PS.preLines(PS.preSummary(CTX({ sheet: { c1: { in: '09:00' } } }))).map((l) => l[1]).join('|'), /1 person has not checked in|1 person has .*not checked in/);
  assert.match(PS.preLines(PS.preSummary(CTX({ tasks: [TASKS[1]] }))).map((l) => l[1]).join('|'), /Nobody has started a pre-event task yet/);
});
await t('1b Day-before checks only when the page already has the plan', () => {
  base.W.HelmEventPlan = { DAYBEFORE: [['vendors', 'Every vendor called'], ['power', 'Power confirmed']] };
  assert.deepEqual(plain(PS.preSummary(CTX({ plan: { checks: { vendors: { done: true } } } })).checks), ['Power confirmed']);
  assert.deepEqual(plain(PS.preSummary(CTX()).checks), []); delete base.W.HelmEventPlan;
});
await t('1c the confirm says how many are open and that nothing is locked (R257)', () => {
  const m = PS.confirmPre('X-1', PS.preSummary(CTX()));
  assert.match(m, /4 pre-event tasks are still open/); assert.match(m, /Nothing is locked: tasks and times can still change/); assert.doesNotMatch(m, /task plan locks/);
  assert.match(PS.confirmPre('X', PS.preSummary(CTX({ tasks: [TASKS[0]] }))), /All pre-event tasks are done/);
  assert.match(PS.confirmPre('X', PS.preSummary(CTX({ tasks: [TASKS[1]] }))), /1 pre-event task is still open/);
});
await t('1d blockers in words, admin override never past a hard one', () => {
  assert.equal(PS.whyText([{ message: 'Event Day opens on 29 Nov 2026 (the event date)' }], 'Event Day'), 'Event Day opens on 29 Nov 2026 (the event date)');
  assert.equal(PS.whyText([{ message: 'the event has no date yet.' }], 'Settlement'), 'Settlement can’t start yet - the event has no date yet');
  assert.deepEqual(plain(PS.gate([{ message: 'x' }], true)), { blocked: true, can: true }); assert.deepEqual(plain(PS.gate([{ message: 'x' }], false)), { blocked: true, can: false });
  assert.equal(PS.gate([{ hard: true }], true).can, false); assert.equal(PS.gate(null, false).can, true, 'a database without 0198: just try');
});
await t('1e stock out and back = the same numbers as HelmStockFlow', () => {
  const res = [{ id: 1, item_id: 'i1', qty: 20, status: 'allocated' }, { id: 2, item_id: 'i2', qty: 5, status: 'reserved' }, { id: 3, item_id: 'i3', qty: 7, status: 'allocated' }, { id: 4, item_id: 'i4', qty: 4, status: 'cancelled' }, { id: 5, item_id: 'i5', qty: 6, status: 'returned' }];
  const cos = [{ item_id: 'i1', qty_out: 20, qty_in: 12, status: 'out', issued_to: 'Ravi', qty_damaged: 2 }, { item_id: 'i5', qty_out: 6, qty_in: 5, status: 'returned', qty_damaged: 1 }, { item_id: 'i6', qty_out: 50, qty_in: 50, qty_used: 30, status: 'returned' }, { item_id: 'i1', qty_out: 9, status: 'cancelled' }];
  const r = PW.stock(res, cos), rows = SF.eventItems({ reservations: res, checkouts: cos }), sum = (k) => rows.reduce((a, x) => a + (x[k] || 0), 0);
  assert.equal(r.out, SF.stillOut(rows)); assert.equal(r.back, sum('back')); assert.equal(r.missing, sum('missing')); assert.equal(r.damaged, sum('damaged')); assert.equal(r.used, sum('used')); assert.equal(r.unused, sum('unused'));
  assert.equal(r.outItems, 2); assert.deepEqual(plain(r.holders), ['Ravi']);
});
await t('1f vendors, crew, refused reads, timesheet', () => {
  const v = PW.vendorsOf([{ status: 'booked', label: 'DJ' }, { status: 'delivered', label: 'Tent' }, { status: 'cancelled' }, { status: 'enquiry' }, { status: 'confirmed' }]);
  assert.deepEqual(plain(v), { total: 3, left: 1, here: ['DJ', 'Partner'], enquiry: 1, noShow: 0 });
  const v2 = PW.vendorsOf([{ id: 'x', status: 'booked', label: 'DJ' }, { id: 'y', status: 'confirmed', label: 'Tent' }, { id: 'z', status: 'booked', label: 'Cook' }], [{ ref_id: 'x', status: 'left' }, { ref_id: 'y', status: 'no_show' }, { ref_id: 'z', status: 'arrived' }]);
  assert.deepEqual(plain(v2), { total: 3, left: 1, here: ['Cook'], enquiry: 0, noShow: 1 }, 'Left on Event-day command counts too');
  assert.equal(PW.crewOut([], null), null); assert.deepEqual(plain(PW.crewOut([], { a: { in: '9', out: '' }, b: { in: '9', out: '23' }, c: {} })), { came: 2, out: 1, here: ['a'] });
  assert.ok(PW.refused({ code: '42501' }) && PW.refused({ message: 'new row violates row-level security' }) && !PW.refused({ message: 'Failed to fetch' }));
  const s = PW.sheetOf({ rows: [{ crew_id: 'a', name: 'Asha', entries: [{ day: '2026-11-28', in: '9', out: '18' }, { day: '2026-11-29', in: '8' }] }, { crew_id: 'b', entries: [] }] });
  assert.deepEqual(plain(s), { map: { a: { in: '8', out: '' } }, names: { a: 'Asha' } });
});

await t('2a cancelled / all events / no quote / another step: hidden', async () => {
  for (const c of [CTX({ quoteId: 'all' }), CTX({ quoteId: null }), CTX({ quote: { status: 'cancelled' } }), CTX({ win: 'onday' })]) { const w = world(); w.W.HelmEventSteps.renderPreDone(w.host, c); assert.equal(w.host.hidden, true); await tick(); assert.equal(w.calls.length, 0); }
  for (const c of [CTX({ quoteId: 'all' }), CTX({ quote: { status: 'cancelled' } })]) { const w = world(); w.W.HelmEventWrap.render(w.host, c); assert.equal(w.host.hidden, true); }
});
await t('2b mark pre-event complete: confirm, setStageGuided("event_day"), onChanged, calm card after', async () => {
  const w = world(); let changed = 0, said = []; const c = CTX({ onChanged: async () => { changed++; }, toast: (m, k) => said.push(k + ':' + m) });
  w.W.HelmEventSteps.renderPreDone(w.host, c); await tick();
  const b = btn(w.host, 'pre:go'); assert.ok(b && !('disabled' in b.attrs)); assert.match(b.className, /tc-primary/);
  b.fire('click'); b.fire('click'); await tick();
  assert.deepEqual(w.calls.filter((x) => x[0] === 'setStageGuided'), [['setStageGuided', 'q1', 'event_day']]);
  assert.equal(w.n('confirm'), 1); assert.equal(changed, 1); assert.match(said[0], /^ok:Pre-event complete/);
  assert.match(w.host.textContent, /Pre-event complete.*Marked at/); assert.equal(btn(w.host, 'pre:go'), undefined);
  w.W.HelmEventSteps.renderPreDone(w.host, CTX({ quote: Object.assign({}, c.quote, { stage: 'event_day' }) })); assert.match(w.host.textContent, /Pre-event complete/);
});
await t('2c it never moves by itself; cancel in the dialog moves nothing and the button comes back', async () => {
  const w = world({ confirm: false }); w.W.HelmEventSteps.renderPreDone(w.host, CTX()); await tick(); assert.equal(w.n('setStageGuided'), 0);
  btn(w.host, 'pre:go').fire('click'); await tick(); assert.equal(w.n('setStageGuided'), 0); assert.equal(btn(w.host, 'pre:go').textContent, 'Mark pre-event complete');
  btn(w.host, 'pre:go').fire('click', { detail: 2 }); await tick(); assert.equal(w.n('confirm'), 1, 'the second half of a double click does nothing');
});
await t('2d no permission: who can; blocked: words, admin override outlined; failed: friendly, sign-in handled', async () => {
  let w = world({ quotesEdit: false }); w.W.HelmEventSteps.renderPreDone(w.host, CTX()); await tick();
  assert.equal(btn(w.host, 'pre:go'), undefined); assert.match(w.host.textContent, /role can change Quotes/); assert.equal(w.n('stageBlockers'), 0);
  w = world(); w.W.HelmEventSteps.renderPreDone(w.host, CTX({ canStage: false })); await tick(); assert.equal(btn(w.host, 'pre:go'), undefined);
  w = world({ blockers: [{ gate: 'event_day', message: 'Event Day opens on 29 Nov 2026 (the event date)' }] }); w.W.HelmEventSteps.renderPreDone(w.host, CTX()); await tick();
  assert.ok('disabled' in btn(w.host, 'pre:go').attrs); assert.match(w.host.textContent, /Event Day opens on 29 Nov 2026/);
  w = world({ role: 'admin', blockers: [{ message: 'Planning needs: menu locked' }] }); w.W.HelmEventSteps.renderPreDone(w.host, CTX()); await tick();
  let b = btn(w.host, 'pre:go'); assert.match(b.textContent, /anyway \(admin\)/); assert.ok(!('disabled' in b.attrs) && !/tc-primary/.test(b.className));
  const said = []; w = world({ move: Object.assign(new Error('down'), { code: 'X' }) }); w.W.HelmEventSteps.renderPreDone(w.host, CTX({ toast: (m, k) => said.push(k + m) })); await tick();
  btn(w.host, 'pre:go').fire('click'); await tick(); assert.equal(w.n('handleAuthError'), 1); assert.match(said[0], /^errCouldn’t mark pre-event complete/); assert.ok(btn(w.host, 'pre:go'));
  const s2 = []; w = world({ move: new Error('JWT expired'), authHandled: true }); w.W.HelmEventSteps.renderPreDone(w.host, CTX({ toast: (m) => s2.push(m) })); await tick(); btn(w.host, 'pre:go').fire('click'); await tick(); assert.equal(s2.length, 0);
  w = world({ move: null }); w.W.HelmEventSteps.renderPreDone(w.host, CTX({ toast: (m) => s2.push(m) })); await tick(); btn(w.host, 'pre:go').fire('click'); await tick(); assert.equal(s2.length, 0, 'the admin cancelled the override: quiet'); assert.ok(btn(w.host, 'pre:go'));
});
await t('2e same data = no redraw, the focus stays', async () => {
  const w = world(); w.W.HelmEventSteps.renderPreDone(w.host, CTX()); await tick(); const b = btn(w.host, 'pre:go'); b.focus();
  w.W.HelmEventSteps.renderPreDone(w.host, CTX({ now: NOW + 30000 })); assert.equal(btn(w.host, 'pre:go'), b);
  w.W.HelmEventSteps.renderPreDone(w.host, CTX({ tasks: TASKS.slice(0, 3) })); assert.notEqual(btn(w.host, 'pre:go'), b); assert.equal(DOC.activeElement, btn(w.host, 'pre:go'));
  assert.equal(w.n('stageBlockers'), 1, 'blockers are not asked on every refresh');
});
const openIt = async (w) => { const d = find(w.host, (n) => n.tagName === 'DETAILS')[0]; d.open = true; d.fire('toggle'); await tick(); return d; };
await t('2f Wrap-up: closed by default, nothing read until opened, never opens or closes by itself', async () => {
  const w = world(); w.W.HelmEventWrap.render(w.host, CTX({ autoWin: 'wrapup', win: 'onday' })); await tick();
  const d = find(w.host, (n) => n.tagName === 'DETAILS')[0]; assert.equal(d.open, false); assert.equal(w.calls.length, 0);
  assert.equal(find(w.host, (n) => n.className === 'hes-now')[0].hidden, false, 'Now mark'); assert.match(w.host.textContent, /Wrap-up/);
  for (const x of ['pre', 'onday', 'wrapup']) w.W.HelmEventWrap.render(w.host, CTX({ autoWin: x, win: 'onday' })); await tick();
  assert.equal(d.open, false); assert.equal(w.calls.length, 0);
  await openIt(w); assert.equal(w.n('bookings'), 1);
  w.W.HelmEventWrap.render(w.host, CTX({ autoWin: 'onday', win: 'onday', tasks: TASKS.slice(0, 2) })); await tick();
  assert.equal(find(w.host, (n) => n.tagName === 'DETAILS')[0], d); assert.equal(d.open, true); assert.equal(w.n('bookings'), 1, 'fresh data is not read again at once');
  w.W.HelmEventWrap.render(w.host, CTX({ quoteId: 'q2' })); assert.equal(find(w.host, (n) => n.tagName === 'DETAILS')[0].open, false, 'another event starts closed');
});
await t('2g the rows, in order, with status and the page that does it', async () => {
  const w = world({ bookings: [{ status: 'booked', label: 'DJ' }, { status: 'delivered', label: 'Tent' }], cos: [{ item_id: 'i', qty_out: 10, qty_in: 4, status: 'out', issued_to: 'Ravi' }],
    checklist: [{ title: 'Hall swept', status: 'open' }, { title: 'Keys', status: 'done' }], issues: [{ title: 'Generator', status: 'open' }, { title: 'x', status: 'resolved' }], timesheet: { rows: [{ crew_id: 'c1', name: 'Asha', entries: [{ day: EV, in: '9:00' }] }] } });
  w.W.HelmEventWrap.render(w.host, CTX({ autoWin: 'onday', win: 'onday' })); await openIt(w);
  // R258: one tab at a time, in this order; the old pack-up lines stay below
  const tabs = find(w.host, (n) => n.attrs.role === 'tab'); assert.deepEqual(tabs.map((x) => x.attrs['data-key']), ['tab:stock', 'tab:vendors', 'tab:crew', 'tab:tasks']); assert.deepEqual(tabs.map((x) => x.attrs['aria-selected']), ['true', 'false', 'false', 'false']);
  const hrefs = [], T = {}; for (const id of ['vendors', 'crew', 'tasks', 'stock']) { btn(w.host, 'tab:' + id).fire('click'); find(w.host, (n) => n.tagName === 'LI' && /hes-row/.test(n.className)).forEach((r) => { T[find(r, (n) => /hes-row-t/.test(n.className))[0].textContent] = r.textContent; }); hrefs.push(...find(w.host, (n) => n.tagName === 'A').map((n) => n.attrs.href)); }
  assert.deepEqual(Object.keys(T).sort(), ['Crew check-out', 'Inventory', 'Open issues', 'Other pack-up notes', 'Tasks', 'Vendors']);
  assert.match(T.Vendors, /1 not left yet.*DJ/); assert.match(T.Inventory, /1 still out.*Given out 10 · came back 4.*Ravi/); assert.match(T['Other pack-up notes'], /1 of 2 done.*Hall swept/); assert.match(T['Crew check-out'], /1 still in/); assert.match(T['Open issues'], /1 open.*Generator/);
  ['teardown.html?quote=q1', 'issues.html?quote=q1', 'settlement.html?quote=q1', 'closure.html?quote=q1'].forEach((x) => assert.ok(hrefs.includes(x), x));
  assert.ok(hrefs.some((x) => /^ops\.html\?quote=q1&task=/.test(x)), 'tasks open on Tasks & Crew'); assert.deepEqual(w.calls.find((c) => c[0] === 'checklist').slice(1), ['q1', 'teardown']);
  assert.match(find(w.host, (n) => n.className === 'hes-sumtxt')[0].textContent, /5 tasks open · 1 vendor not left yet · 6 pieces of stock out · 1 issue open/);
});
await t('2h areas a role does not have and refused reads: the row is simply not there; a failed read = quiet Try again', async () => {
  let w = world({ can: { vendors: false, inventory: false, plan: false, issues: false, staff: false, settlement: false } }); w.W.HelmEventWrap.render(w.host, CTX({ win: 'onday', autoWin: 'onday' })); await openIt(w);
  assert.deepEqual(w.calls.map((c) => c[0]).filter((x) => x !== 'stageBlockers'), []); assert.equal(find(w.host, (n) => /hes-row-t/.test(n.className)).length, 1); assert.equal(find(w.host, (n) => n.attrs.role === 'tab').length, 1); assert.ok(!/Settlement →.*Teardown/.test(w.host.textContent)); assert.match(w.host.textContent, /1 Closure →/);
  w = world({ bookings: Object.assign(new Error('permission denied'), { code: '42501' }), issues: new Error('Failed to fetch') }); w.W.HelmEventWrap.render(w.host, CTX({ win: 'onday', autoWin: 'onday' })); await openIt(w);
  assert.equal(btn(w.host, 'tab:vendors'), undefined); btn(w.host, 'tab:tasks').fire('click'); assert.match(w.host.textContent, /Couldn’t check this just now/);
  const b = btn(w.host, 'retry:issues'); const n = w.n('issues'); b.fire('click'); await tick(); assert.equal(w.n('issues'), n + 1);
});
await t('2i mark event complete -> Settlement: same rules as before; done state has the three links', async () => {
  const w = world(); let ch = 0; const said = []; w.W.HelmEventWrap.render(w.host, CTX({ autoWin: 'wrapup', win: 'onday', onChanged: () => { ch++; }, toast: (m) => said.push(m) })); await openIt(w);
  const b = btn(w.host, 'wrap:go'); assert.equal(b.textContent, 'Mark event complete → Settlement'); assert.match(b.className, /tc-primary/);
  assert.deepEqual(w.calls.find((c) => c[0] === 'stageBlockers').slice(1), ['q1', 'settlement']);
  b.fire('click'); b.fire('click'); await tick(); assert.deepEqual(w.calls.filter((x) => x[0] === 'setStageGuided'), [['setStageGuided', 'q1', 'settlement']]); assert.equal(ch, 1);
  assert.match(said[0], /moved to Settlement/); assert.match(w.host.textContent, /Event complete.*1 Teardown →.*2 Settlement →.*3 Closure →/); assert.equal(btn(w.host, 'wrap:go'), undefined);
  const v = world(); v.W.HelmEventWrap.render(v.host, CTX({ autoWin: 'daybefore', win: 'daybefore' })); await openIt(v); assert.equal(btn(v.host, 'wrap:go'), undefined); assert.match(v.host.textContent, /on the event day/); assert.equal(v.n('stageBlockers'), 0);
  const x = world({ quotesEdit: false }); x.W.HelmEventWrap.render(x.host, CTX({ autoWin: 'onday', win: 'onday' })); await openIt(x); assert.equal(btn(x.host, 'wrap:go'), undefined); assert.match(x.host.textContent, /role can change Quotes/);
});
await t('2j openTask is used when the page gives it; the light refresh keeps the focus', async () => {
  const w = world(); const opened = []; const c = CTX({ autoWin: 'onday', win: 'onday', openTask: (id) => opened.push(id) }); w.W.HelmEventWrap.render(w.host, c); await openIt(w);
  btn(w.host, 'tab:tasks').fire('click'); const b = btn(w.host, 'task:b'); b.focus(); b.fire('click'); assert.deepEqual(opened, ['b']);
  w.W.HelmEventWrap.render(w.host, Object.assign({}, c, { tasks: TASKS.slice(0, 2) })); assert.equal(DOC.activeElement, btn(w.host, 'task:b'));
});

await t('3a safety: no HTML strings, no inline style, no money words, the only write is setStageGuided', () => {
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(JS)); assert.ok(!/\bstyle\s*[:=]|\.style\b/.test(JS));
  assert.ok(!/₹|\bINR\b|toLocaleString|balance|\.cost\b|\.price|\.total_|amount/i.test(JS.replace(/\/\*[\s\S]*?\*\//g, '')));
  const w = [...JS.matchAll(/\b(?:store|B\(\)|inv|sh)\.([a-zA-Z.]+)\(/g)].map((m) => m[1]).sort();
  assert.deepEqual([...new Set(w)], ['auth.handleAuthError', 'bookings.list', 'checklist.list', 'checkouts.list', 'dayops.list', 'extras.list', 'issues.list', 'quotes.setStageGuided', 'quotes.stageBlockers', 'reservations', 'stock.story', 'studioLocale', 'timesheet', 'vendorRequests.list', 'vendors.listAll', 'wrapRecords.get']);
  assert.equal((JS.match(/setStageGuided\(/g) || []).length, 1); assert.ok(!/setStage\(/.test(JS));
});
await t('3b CSS: theme tokens only, 44px targets, white words on the accent, scoped', () => {
  assert.deepEqual([...CSS.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/#[0-9a-f]{3,8}\b/gi)].map((m) => m[0]).filter((x) => x !== '#fff'), []);
  assert.match(CSS, /\.hes \.tc-btn\.tc-primary[^{]*\{background:var\(--tc-acc\);[^}]*color:#fff\}/); assert.match(CSS, /a\.tc-btn\.tc-primary:visited/); assert.match(CSS, /min-height:44px/);
  CSS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media[^{]*\{/g, '').split('}').map((x) => x.split('{')[0].trim()).filter(Boolean).forEach((s) => s.split(',').forEach((x) => assert.match(x.trim(), /hes/, x)));
});
console.log(`\nr251-event-steps: ${pass} passed, ${fail} failed`); if (fail) process.exit(1);
