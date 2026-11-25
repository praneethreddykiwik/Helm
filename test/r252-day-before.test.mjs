// R252: public/day-before.js - the Day-before card as one readiness checklist from the real data.
//   1 pure: start time, task per line, vendors, stock against the floor plan, floor counts, masks in event-plan.js
//   2 behaviour on a small fake DOM: 11 ticks once, optional assign -> one Day-before task with a time, no second task, lock,
//     permissions, refused / failed reads, saves read back, no repeat reads, nothing written without a press
//   3 safety: no HTML strings, no inline style, no money, theme tokens, the callers and the script tags
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); } };
const JS = read('public/day-before.js'), CSS = read('public/day-before.css'), EPJS = read('public/event-plan.js'), TSJS = read('public/task-status.js');
const plain = (x) => JSON.parse(JSON.stringify(x));
const tick = async () => { for (let i = 0; i < 25; i++) await new Promise((r) => setTimeout(r, 0)); };

/* ---- a very small DOM ---- */
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
const NOW = Date.parse('2026-11-24T04:30:00Z'), Q = 'q1';
function world(o = {}) {
  const body = new El('body'); DOC = { activeElement: body, body, hidden: false, createElement: (x) => new El(x), createTextNode: (s) => ({ textContent: s }), getElementById: (i) => body.all().find((n) => n.id === i) || null };
  const host = new El('section'); host.id = 'dh'; body.appendChild(host);
  const reads = {}, writes = [], toasts = [], deny = o.deny || [], fails = o.fails || [];
  const rd = (k, f) => async (...a) => { reads[k] = (reads[k] || 0) + 1; if (fails.includes(k)) throw new Error('Failed to fetch'); return f(...a); };
  const db = { checks: {}, tasks: o.tasks || [], bk: o.bk || [{ id: 'b1', vendor_id: 'v1', label: 'Catering', qty: 1, status: 'booked', cost: 987654 }], ck: o.ck || [{ id: 'k1', section: 'logistics', title: 'Tempo', status: 'open', owner: '' }] };
  const vs = [{ id: 'v1', name: 'Annapurna', phone: '9848011111', upi: 'x' }, { id: 'v2', name: 'No Phone Co', phone: '' }];
  let n = 0;
  const B = { auth: { canView: async (a) => !deny.includes(a), canEditArea: async (a) => !deny.includes(a) && !deny.includes(a + ':e'), canAssignTasks: async () => !deny.includes('tasks') },
    readiness: { check: rd('ready', async () => ({ ready: true, checks: [{ key: 'date', label: 'Event date set', critical: true, ok: true }, { key: 'vendors', label: 'Vendors confirmed', critical: true, ok: true, detail: 'all confirmed' }, { key: 'stock', label: 'Stock sourced', critical: true, ok: true, detail: 'no shortages' }, { key: 'payments', label: 'Advance received', ok: true }] })) },
    bookings: { list: rd('bookings', async () => plain(db.bk)), update: async (id, p) => { writes.push(['booking', id, plain(p)]); if (!o.rls) Object.assign(db.bk.find((x) => x.id === id), p); return true; } },
    vendors: { listAll: rd('vendors', async () => plain(vs)) }, resources: { listNeeds: rd('needs', async () => []) },
    inventory: { layout: { needs: rd('layout', async () => (o.layout === undefined ? { types: [], items: [], unlinked: [] } : o.layout)) }, reservations: rd('res', async () => []), checkouts: { list: rd('co', async () => []) }, shortages: rd('short', async () => []) },
    checklist: { list: rd('checklist', async () => plain(db.ck)), update: async (id, p) => { writes.push(['chk', id, plain(p)]); if (!o.rls) Object.assign(db.ck.find((x) => x.id === id), p); return true; } },
    people: { options: rd('people', async () => [{ id: 'c1', name: 'Ravi', kind: 'staff' }]) }, calendar: { wouldClash: async () => ({ clash: false }) },
    ops: { dayPlan: { check: async (q, k, d) => { writes.push(['check', k, d]); db.checks[k] = { done: d }; } }, planLock: { floor: rd('floor', async () => ({ items: [{ type: 'table', label: 'Round Table', properties: { seats: 8 } }, { type: 'table', label: 'Round Table', properties: { seats: 8 } }] })) },
      listCrew: rd('crew', async () => [{ id: 'c1', name: 'Ravi', phone: '9000000001', email: 'r@example.test', day_rate: 777 }, { id: 'c2', name: 'No Phone', phone: '' }]), listTasks: rd('tasks', async () => plain(db.tasks)),
      assignTasks: async (q, c, ti, id, nm) => { writes.push(['assign', c, plain(ti), id]); db.tasks.push({ id: 'n' + (++n), category: c, title: ti[0], crew_id: id, assignee_name: nm, status: 'assigned', planned_start: null }); },
      assignTasksVendor: async (q, c, ti, id) => { writes.push(['vendor', c, plain(ti), id]); db.tasks.push({ id: 'n' + (++n), category: c, title: ti[0], vendor_id: id, assignee_name: 'Annapurna', status: 'assigned', planned_start: null }); },
      setSchedule: async (id, s, e, d) => { writes.push(['time', id, s, d]); Object.assign(db.tasks.find((x) => x.id === id), { planned_start: s }); }, reassign: async (id, c, nm) => { writes.push(['reassign', id, c]); Object.assign(db.tasks.find((x) => x.id === id), { crew_id: c, assignee_name: nm, status: 'assigned' }); } } };
  const W = { document: DOC, BPStore: B, BPUI: { confirm: async () => true, friendlyError: (e) => String(e.message) }, Intl, Date, setTimeout, console, location: { pathname: '/monitor.html' } }; W.window = W; W.globalThis = W;
  vm.createContext(W); [TSJS, EPJS, JS].forEach((x) => vm.runInContext(x, W));
  const ctx = () => Object.assign({ plan: { can_edit: !deny.includes('tasks'), checks: plain(db.checks) }, tasks: plain(db.tasks), quoteId: Q, eventDate: '2026-11-29', eventTime: '7:00 PM', tz: 'Asia/Kolkata', now: NOW, nameOf: (x) => x.assignee_name || '', toast: (m, k) => toasts.push([k, m]), onChanged: async () => draw() }, o.ctx || {});
  const draw = () => W.HelmEventPlan.renderDayBefore(host, ctx());
  const by = (id) => DOC.getElementById(id), find = (f) => host.all().filter(f);
  return { W, host, draw, reads, writes, toasts, db, by, find, D: W.HelmDayBefore, EP: W.HelmEventPlan, text: () => host.textContent, B, fails };
}
const secs = (w) => w.find((n) => n.className === 'hdb-sec-h'), sec = (w, k) => w.by('dhG-' + k), words = (w, k) => sec(w, k).textContent;   // R257: every section is always open
const tops = (w) => w.find((n) => / top$/.test(n.className)).map((n) => n.textContent), menu = (w, key) => w.by('hdbMenu-' + key).all().filter((n) => n.attrs.role === 'menuitem').map((n) => n.textContent);
const base = world(), D = base.D, EP = base.EP;
// the real clock is after the fake one: the card takes "now" from ctx; readyCheck / cache use Date.now

await t('1a a Day-before task starts 10 AM the day before; already past = later that day; the event day / no date = no time', () => {
  const s = (now, ev = '2026-11-29') => D.startFor({ eventDate: ev, tz: 'Asia/Kolkata', now: Date.parse(now) });
  assert.equal(s('2026-11-24T10:00:00+05:30'), '2026-11-28T04:30:00.000Z');
  assert.equal(s('2026-11-28T15:07:00+05:30'), '2026-11-28T10:15:00.000Z');
  const late = s('2026-11-28T23:50:00+05:30'); assert.equal(late, '2026-11-28T18:25:00.000Z');
  assert.equal(s('2026-11-29T09:00:00+05:30'), null); assert.equal(s('2026-11-24T10:00:00+05:30', ''), null);
  for (const iso of ['2026-11-28T04:30:00.000Z', '2026-11-28T10:15:00.000Z', late]) assert.equal(base.W.HelmTaskStatus.taskStep({ title: 'Load list packed and checked', category: 'Day before', planned_start: iso }, { eventDate: '2026-11-29', eventTime: '7:00 PM', tz: 'Asia/Kolkata' }), 'daybefore');
});
await t('1b the task of a line: same category + words, an open one wins, cancelled ones never, a vendor job only for that vendor', () => {
  const T = (o) => Object.assign({ category: 'Day before', title: 'Every vendor called', crew_id: 'c', status: 'assigned' }, o);
  assert.equal(D.lineTask([T({ status: 'cancelled' })], 'Every vendor called'), null);
  assert.equal(D.lineTask([T({ category: 'Other' })], 'Every vendor called'), null);
  const r = D.lineTask([T({ id: 'a', status: 'completed' }), T({ id: 'b', status: 'accepted', title: ' every  VENDOR called ' })], 'Every vendor called'); assert.equal(r.t.id, 'b'); assert.equal(r.held, true);
  assert.equal(D.lineTask([T({ status: 'rejected' })], 'Every vendor called').free, true);
  assert.equal(D.lineTask([T({ vendor_id: 'v1' })], 'Every vendor called', 'v2'), null);
});
await t('1c the 11 server keys sit in a group each; nothing invented', () => {
  assert.deepEqual(plain(EP.DAYBEFORE.map((d) => d[0])), ['vendors', 'headcount', 'crew_call', 'load_list', 'transport', 'venue_access', 'power', 'permits', 'weather', 'runsheet', 'client']);
  assert.deepEqual(plain(EP.DAYBEFORE.map((d) => D.groupOf(d[0]))), ['vendors', 'menu', 'people', 'stock', 'logistics', 'logistics', 'logistics', 'logistics', 'logistics', 'final', 'final']);
});
const LAY = { types: [{ layout_type: 'table', label: 'Round Table', objects: 12, seats: 96 }, { layout_type: 'chiavari', label: 'Chiavari chair', objects: 120, seats: 120 }],
  items: [{ item_id: 'i1', name: 'Chiavari chair', needed: 120, held: 80, free: 20, to_borrow: 20, to_borrow_shared: 25, types: ['chiavari'] }, { item_id: 'i2', name: 'Round table', needed: 12, held: 12, free: 3, to_borrow: 0, types: ['table'] }],
  unlinked: [{ layout_type: 'led', label: 'LED Wall', objects: 2, seats: 0 }, { layout_type: 'exit', label: 'Exit Zone', objects: 3, seats: 0 }] };
await t('1d stock: needed / reserved / given out / missing per product, what to reserve and what to get from a vendor', () => {
  const m = D.stockRows({ layout: LAY, reservations: [{ item_id: 'i1', qty: 80, status: 'reserved' }, { item_id: 'i2', qty: 12, status: 'reserved' }, { item_id: 'i9', qty: 1, status: 'reserved' }, { item_id: 'i1', qty: 50, status: 'released' }], checkouts: [{ item_id: 'i2', qty_out: 8, qty_in: 2, status: 'out' }, { item_id: 'i2', qty_out: 8, qty_in: 2, status: 'returned' }], bookings: [] });
  const c = m.rows[0]; assert.deepEqual([c.name, c.needed, c.reserved, c.out, c.missing, c.toReserve, c.toGet, c.state, c.done], ['Chiavari chair', 120, 80, 0, 40, 20, 20, 'short', false]);
  assert.equal(c.shared, 5);
  const r = m.rows[1]; assert.deepEqual([r.out, r.missing, r.state, r.done], [6, 0, 'ok', true]);
  assert.equal(m.extra, 1); assert.deepEqual(plain(m.unlinked.map((u) => u.type)), ['led'], 'an exit mark is no product');
});
await t('1e a vendor booking covers a product only for the same thing; Asked is not yet covered; a cancelled one never counts', () => {
  const run = (bk, x = {}) => D.stockRows(Object.assign({ layout: LAY, reservations: [], checkouts: [], bookings: bk }, x)).rows.filter((r) => r.id === 'i1')[0];
  assert.equal(run([{ id: 'b', label: 'Chiavari chair covers', qty: 20, status: 'booked' }]).toGet, 20);
  assert.equal(run([{ id: 'b', label: 'Chiavari chair', qty: 20, status: 'cancelled' }]).toGet, 20);
  const ask = run([{ id: 'b', label: 'Chiavari chair - rent 20 (stock shortfall)', status: 'enquiry' }]); assert.deepEqual([ask.toGet, ask.toReserve, ask.state], [0, 20, 'reserve']);
  assert.equal(run([{ id: 'b', label: 'anything', qty: 20, status: 'booked', need_id: 'n' }], { needs: [{ id: 'n', item_id: 'i1', label: 'x' }] }).toGet, 0);
  assert.equal(run([{ id: 'b', label: 'Chiavari chair', qty: 20, status: 'booked', need_id: 'n' }], { needs: [{ id: 'n', item_id: 'i2', label: 'Round table' }] }).toGet, 20, 'booked for another need');
  assert.equal(run([{ id: 'b', label: 'z', qty: 5, status: 'booked' }], { shortages: [{ item_id: 'i1', booking_id: 'b' }] }).toGet, 15);
});
await t('1f the floor plan in words; money columns are dropped from a booking', () => {
  const ty = D.floorTypes({ items: [{ type: 'table', label: 'Round Table', properties: { seats: 8 } }, { type: 'seatblock', label: 'Block', properties: { rows: 10, cols: 5 } }, { type: 'chiavari', label: 'Chair' }, null] });
  assert.match(D.planWords(ty), /Round Table × 1/); assert.match(D.planWords(ty), /59 seats in all/); assert.equal(D.planWords([]), '');
  assert.deepEqual(Object.keys(D.cleanBooking({ id: 1, cost: 5, advance: 2, note: 'n' })).sort(), ['id', 'kind', 'label', 'need_id', 'qty', 'status', 'vendor_id']);
});
await t('1g readyMask: without Vendors / Inventory view those lines are "Not visible to you", never done, never counted', () => {
  const r = { checks: [{ key: 'vendors', critical: true, ok: true }, { key: 'stock', critical: true, ok: true }, { key: 'menu', critical: true, ok: true }, { key: 'payments', ok: true }] };
  const m = EP.readyMask(r, { vendors: false, stock: false }), s = EP.readySum(m);
  assert.deepEqual([s.done, s.of, s.ok.length, s.hidden.length], [1, 1, 1, 2]); assert.equal(m.checks[0].detail, 'Not visible to you'); assert.equal(r.checks[0].ok, true, 'the answer itself is not changed');
  assert.equal(EP.readySum(EP.readyMask(r, { vendors: true, stock: true })).of, 3);
});

await t('2a one card: all 11 ticks exactly once, the 7 sections in order, reads once and in parallel, nothing written', async () => {
  const w = world({ layout: LAY }); w.draw(); await tick();
  const ids = w.find((n) => /^epChk-/.test(n.id)).map((n) => n.id); assert.equal(ids.length, 11); assert.equal(new Set(ids).size, 11);
  assert.deepEqual(secs(w).slice(0, 7).map((n) => n.firstChild.textContent), ['Vendors', 'Menu and guest count', 'Plan and floor layout', 'Inventory and stock', 'Logistics', 'People', 'Final checks']); assert.match(w.text(), /Chiavari chair × 120, Round Table × 12 · 216 seats in all/);
  assert.doesNotMatch(w.text(), /Needed 120/); w.by('hdbT-st-i1').click(); assert.match(w.text(), /Needed 120 · Reserved 0 · Given out 0 · Missing 40/); assert.deepEqual(w.writes, []);
  const r = plain(w.reads); for (let i = 0; i < 10; i++) w.draw(); await tick(); assert.deepEqual(plain(w.reads), r, 'the 30 s redraw reads nothing');
  assert.ok(Object.keys(r).every((k) => r[k] === 1)); w.by('hdbRefresh').click(); await tick(); assert.equal(w.reads.layout, 2); assert.equal(w.reads.ready, 2);
  assert.doesNotMatch(w.text(), /987654|9,87,654|777/);
});
await t('2b nothing is read while the card is hidden or the tab is in the background; noReady leaves part 1 out', async () => {
  const w = world(); w.host.hidden = true; w.draw(); await tick(); assert.deepEqual(plain(w.reads), {});
  w.host.hidden = false; DOC.hidden = true; w.draw(); await tick(); assert.deepEqual(plain(w.reads), {});
  const x = world({ ctx: { noReady: true } }); x.draw(); await tick(); assert.equal(x.reads.ready, undefined); assert.match(secs(x)[0].textContent, /^Vendors/); assert.equal(x.by('hdbMk-rd-date'), null);
});
await t('2c the redraw keeps the DOM when nothing changed, and never touches an open form', async () => {
  const w = world(); w.draw(); await tick(); const first = w.host.firstChild; w.draw(); assert.equal(w.host.firstChild, first);
  w.by('hdbAs-vendors').click(); await tick(); const f = w.by('hdbPick'); w.db.tasks.push({ id: 'x', category: 'A', title: 'B', status: 'assigned' }); w.draw(); assert.equal(w.by('hdbPick'), f);
  w.find((n) => n.className === 'hdb-form')[0].fire('keydown', { key: 'Escape', stopPropagation() {} }); assert.equal(w.by('hdbPick'), null); assert.equal(DOC.activeElement.id, 'hdbMore-line-vendors', 'focus back on the More button');
});
const give = async (w, id, val) => { w.by(id).click(); await tick(); const p = w.by('hdbPick'); if (val) { p.value = val; p.fire('change'); } w.by('hdbGo').click(); w.by('hdbGo') && w.by('hdbGo').click(); await tick(); };
await t('2d Assign (in More, optional): one real Day-before task with the day-before time; pressed twice = once; then it shows who has it', async () => {
  const w = world(); w.draw(); await tick(); await give(w, 'hdbAs-vendors', 'c:c1');
  assert.deepEqual(w.writes, [['assign', 'Day before', ['Every vendor called'], 'c1'], ['time', 'n1', w.D.startFor({ eventDate: '2026-11-29', tz: 'Asia/Kolkata', now: NOW }), null]]);
  assert.match(w.toasts[0][1], /Given to Ravi\. They get an e-mail/); assert.equal(w.by('hdbAs-vendors'), null); assert.match(w.text(), /With Ravi/);
  assert.match(w.text(), /Not accepted yet/);
});
await t('2e a vendor can be picked; nobody picked / no phone = nothing written; the hint says optional + e-mailed', async () => {
  const w = world(); w.draw(); await tick(); await give(w, 'hdbAs-permits', ''); assert.deepEqual(w.writes, []); assert.match(w.text(), /Pick who should do it/);
  assert.match(w.by('hdbHint').textContent, /^Optional.*e-mailed/); assert.ok(w.by('hdbPick').all().filter((n) => /no phone/.test(n.textContent) && n.tagName === 'OPTION').every((n) => n.attrs.disabled === ''));
  const p = w.by('hdbPick'); p.value = 'v:v1'; p.fire('change'); w.by('hdbGo').click(); await tick(); assert.deepEqual(w.writes[0], ['vendor', 'Day before', ['Permits in hand'], 'v1']); assert.equal(w.writes[1][0], 'time');
});
await t('2f given out meanwhile by someone else (not on this screen yet): no second task', async () => {
  const w = world(); w.draw(); await tick(); w.by('hdbAs-vendors').click(); await tick();
  w.db.tasks.push({ id: 'z', category: 'Day before', title: 'Every vendor called', crew_id: 'c9', assignee_name: 'Meena', status: 'accepted' });
  const p = w.by('hdbPick'); p.value = 'c:c1'; p.fire('change'); w.by('hdbGo').click(); await tick(); assert.deepEqual(w.writes, []); assert.match(w.toasts[0][1], /Already with Meena/);
});
await t('2g turned down: the SAME task is passed on (no copy), staff only; done = no assign button', async () => {
  const w = world({ tasks: [{ id: 'r', category: 'Day before', title: 'Permits in hand', crew_id: 'c9', assignee_name: 'Meena', status: 'rejected', planned_start: '2026-11-28T04:30:00Z' }, { id: 'd', category: 'Day before', title: 'Every vendor called', crew_id: 'c1', assignee_name: 'Ravi', status: 'completed' }] }); w.draw(); await tick();
  assert.equal(w.by('hdbAs-vendors'), null); w.by('hdbAs-permits').click(); await tick(); assert.deepEqual(w.by('hdbPick').all().filter((n) => n.tagName === 'OPTGROUP').map((n) => n.attrs.label), ['Staff']);
  const p = w.by('hdbPick'); p.value = 'c:c1'; p.fire('change'); w.by('hdbGo').click(); await tick(); assert.deepEqual(w.writes, [['reassign', 'r', 'c1']]);
});
await t('2h R257: a closed event gives out nothing, ticks still work; a lock answer changes nothing; no permission = no ticks', async () => {
  const w = world({ ctx: { closed: true } }); w.draw(); await tick(); assert.equal(w.find((n) => /^hdb(As|Job)-/.test(n.id)).length, 0); w.by('epChk-power').click(); await tick(); assert.deepEqual(w.writes, [['check', 'power', true]]);
  assert.equal(w.by('epChk-power').attrs['aria-pressed'], 'true');
  const x = world({ deny: ['tasks'] }); x.draw(); await tick(); assert.equal(x.find((n) => /^hdb(As|Job)-/.test(n.id)).length, 0); assert.ok(x.find((n) => /^epChk-/.test(n.id)).every((n) => n.attrs.disabled === ''));
  const y = world({ deny: ['staff'] }); y.draw(); await tick(); assert.equal(y.find((n) => /^hdbAs-/.test(n.id)).length, 0, 'without Staff view a second task could not be seen'); assert.doesNotMatch(y.text(), /No tasks on this event/);
  const z = world({ ctx: { locked: true } }); z.draw(); await tick(); assert.ok(z.find((n) => /^hdbAs-/.test(n.id)).length > 0, 'no event-day lock any more');
});
await t('2i vendors: Call, Mark confirmed is read back; a refused save (no row changed) is said, never shown as saved', async () => {
  const w = world(); w.draw(); await tick(); assert.ok(w.find((n) => n.attrs.href === 'tel:9848011111').length); w.by('hdbCf-b1').click(); await tick(); assert.deepEqual(w.writes, [['booking', 'b1', { status: 'confirmed' }]]); assert.match(w.toasts[0][1], /is confirmed/); assert.equal(w.reads.ready, 2, 'Vendors confirmed is worked out again');
  const x = world({ rls: true }); x.draw(); await tick(); x.by('hdbCf-b1').click(); await tick(); assert.deepEqual([x.toasts[0][0], /not saved/.test(x.toasts[0][1])], ['err', true]); assert.ok(x.by('hdbCf-b1'));
  const y = world({ deny: ['vendors:e'] }); y.draw(); await tick(); assert.equal(y.by('hdbCf-b1'), null);
  const z = world({ bk: [] }); z.draw(); await tick(); assert.match(z.text(), /No vendors booked/); assert.equal(z.reads.vendors, undefined);
});
await t('2j a vendor job: typed words, that vendor, Day before; the same open job is not given twice', async () => {
  const w = world(); w.draw(); await tick(); w.by('hdbJob-b1').click(); await tick(); const bad = w.by('hdbJob'); bad.value = '<b>x'; bad.fire('input'); w.by('hdbGo').click(); await tick(); assert.deepEqual(w.writes, []); const i = w.by('hdbJob'); i.value = 'Bring 2 spare mics'; i.fire('input'); w.by('hdbGo').click(); await tick();
  assert.deepEqual(w.writes[0], ['vendor', 'Day before', ['Bring 2 spare mics'], 'v1']);
  const n = w.writes.length; w.by('hdbJob-b1').click(); await tick(); const j = w.by('hdbJob'); j.value = ' bring 2  spare mics'; j.fire('input'); w.by('hdbGo').click(); await tick(); assert.equal(w.writes.length, n);
});
await t('2k logistics: done, N/A and owner go through checklist.update and are read back; view only = no buttons', async () => {
  const w = world(); w.draw(); await tick(); w.by('hdbCk-k1').click(); await tick(); assert.deepEqual(w.writes, [['chk', 'k1', { status: 'done' }]]);
  const x = world(); x.draw(); await tick(); x.by('hdbOw-k1').click(); await tick(); const p = x.by('hdbPick'); p.value = 'Ravi'; p.fire('change'); x.by('hdbGo').click(); await tick(); assert.deepEqual(x.writes, [['chk', 'k1', { owner: 'Ravi' }]]); assert.match(x.text(), /Owner: Ravi/); assert.equal(DOC.activeElement.id === 'hdbPick', false);
  x.by('hdbNa-k1').click(); await tick(); assert.deepEqual(x.writes[1], ['chk', 'k1', { status: 'na' }]);
  const y = world({ deny: ['plan:e'] }); y.draw(); await tick(); assert.equal(y.by('hdbNa-k1'), null); assert.equal(y.by('hdbCk-k1').attrs.disabled, '');
  const z = world({ rls: true }); z.draw(); await tick(); z.by('hdbCk-k1').click(); await tick(); assert.match(z.toasts[0][1], /not saved/); assert.equal(z.by('hdbCk-k1').attrs['aria-pressed'], 'false');
});
await t('2l a refused area is left out quietly and its readiness line is not done; floor counts stay without Inventory', async () => {
  const w = world({ deny: ['vendors', 'inventory', 'logistics'] }); w.draw(); await tick(); const tx = w.text();
  assert.equal(w.reads.bookings, undefined); assert.equal(w.reads.layout, undefined); assert.equal(w.reads.checklist, undefined); assert.match(tx, /Round Table × 2 · 16 seats in all/); assert.match(tx, /Stock numbers are not visible to you/);
  assert.equal((tx.match(/Not visible to you/g) || []).length, 2); assert.doesNotMatch(tx, /Couldn't check|No vendors booked/); assert.doesNotMatch(words(w, 'vendors'), /✓/);
  assert.equal(w.find((n) => /^epChk-/.test(n.id)).length, 11);
});
await t('2m a failed read says "Couldn\'t check" + Try again (that group only); the readiness line it stands on is not done', async () => {
  const w = world({ fails: ['bookings'] }); w.draw(); await tick(); assert.match(w.text(), /Couldn't check the vendors/); assert.match(w.text(), /Vendors confirmed.*Couldn't check/); assert.match(w.by('dhTot').textContent, /Some parts could not be checked/); assert.match(words(w, 'vendors'), /Couldn't check/);
  const r = w.reads.layout; w.fails.length = 0; w.by('hdbRetry-thevendors').click(); await tick(); assert.doesNotMatch(w.text(), /Couldn't check/); assert.equal(w.reads.layout, r); assert.match(w.text(), /Annapurna/);
  const x = world({ fails: ['ready'] }); x.draw(); await tick(); assert.match(x.text(), /Couldn't check the plan/);
});
await t('2n missing stock: "Get from a vendor" opens HelmStockVendor with the numbers; without it a link to the resource plan', async () => {
  const w = world({ layout: LAY }); w.draw(); await tick(); assert.equal(w.by('hdbGet-i1').tagName, 'A', 'a link, not a dialog'); assert.ok(w.find((n) => /^Get from a vendor/.test(n.textContent) && /^resources\.html\?quote=q1/.test(n.attrs.href || '')).length);
  const x = world({ layout: LAY }); const calls = []; x.W.HelmStockVendor = { open: (o) => calls.push(o) }; x.draw(); await tick(); x.by('hdbGet-i1').click(); x.by('hdbGetT-led').click();
  assert.deepEqual(calls.map((c) => [c.quoteId, c.label, c.qty, c.itemId, c.layoutType]), [['q1', 'Chiavari chair', 20, 'i1', 'chiavari'], ['q1', 'LED Wall', 2, null, 'led']]);
  const before = x.reads.layout; calls[0].onDone(); await tick(); assert.equal(x.reads.layout, before + 1); assert.deepEqual(x.writes, []);
  const y = world({ layout: LAY, deny: ['vendors:e'] }); y.W.HelmStockVendor = { open() {} }; y.draw(); await tick(); assert.equal(y.by('hdbGet-i1'), null);
});

const LAY0 = { types: [{ layout_type: 'table', label: 'Round Table', objects: 1, seats: 8 }], items: [], unlinked: [] };
const FULL = (o = {}) => world(Object.assign({ layout: LAY, bk: [{ id: 'b1', vendor_id: 'v1', label: 'Catering', status: 'booked' }, { id: 'b2', vendor_id: 'v2', label: 'DJ', status: 'confirmed' }],
  ck: [{ id: 'k1', section: 'compliance', title: 'Police / loudspeaker permission', detail: 'ref 44', owner: 'Salma', due_date: '2026-11-22', status: 'open' }, { id: 'k2', section: 'compliance', title: 'Fire NOC', status: 'done' }, { id: 'k3', section: 'logistics', title: 'Tempo', status: 'open' }, { id: 'k4', section: 'guests', title: 'Family', qty: 180, status: 'done' }, { id: 'k5', section: 'guests', title: 'Friends', qty: 60, status: 'open' }, { id: 'k6', section: 'logistics', title: 'Valet', status: 'na' }],
  tasks: [{ id: 'r', category: 'Day before', title: 'Venue access confirmed', crew_id: 'c9', assignee_name: 'Meena', status: 'rejected' }] }, o));
await t('4a the top: one sentence, a bar, "Do these first" = at most 5, most urgent first, each with Mark done (when it can be ticked) and Show', async () => {
  const w = FULL(); w.draw(); assert.match(w.by('dhTot').textContent, /Checking/); await tick(); const m = /^(\d+) of (\d+) done - (\d+) to go$/.exec(w.by('dhTot').textContent); assert.ok(m); assert.equal(+m[1] + +m[3], +m[2]);
  const bar = w.find((n) => n.tagName === 'PROGRESS')[0]; assert.deepEqual([bar.attrs.value, bar.attrs.max, bar.attrs['aria-labelledby']], [m[1], m[2], 'dhTot']);
  const tp = tops(w); assert.equal(tp.length, 5); assert.match(tp[0], /^Police.*Overdue.*Mark doneShow$/); assert.match(tp[1], /^Chiavari chairMissing 20/); assert.match(tp[2], /^AnnapurnaNot confirmed.*Mark confirmedShow$/); assert.match(tp[3], /^Venue access confirmedTurned down · by Meena.*Mark doneGive to someoneShow$/);
  assert.deepEqual(w.writes, []);
  w.by('hdbTop-hdbCk-k1').click(); await tick(); assert.deepEqual(w.writes, [['chk', 'k1', { status: 'done' }]]); assert.doesNotMatch(tops(w).join('|'), /Police/); assert.equal(w.db.checks.permits, undefined, 'the tick stays its own thing');
  w.by('hdbTop-hdbCf-b1').click(); await tick(); assert.deepEqual(w.writes[1], ['booking', 'b1', { status: 'confirmed' }]);
  w.by('hdbTop-hdbAs-venue_access').click(); await tick(); assert.equal(DOC.activeElement.id, 'hdbPick'); assert.equal(w.writes.length, 2);
  const v = FULL({ deny: ['vendors:e', 'plan:e', 'tasks'] }); v.draw(); await tick(); assert.match(tops(v)[0], /Show$/); assert.doesNotMatch(tops(v).join('|'), /Mark|Give/); v.find((n) => n.id === 'hdbTop-show-ck-k1')[0].click(); assert.equal(DOC.activeElement.id, 'hdbT-ck-k1'); { let n = v.by('hdbT-ck-k1'); while (n.tagName !== 'LI') n = n.parentNode; assert.match(n.className, /is-flash/, 'Show lights the line up'); } assert.match(v.text(), /ref 44/); assert.deepEqual(v.writes, []);
});
await t('4b every section is open, done lines stay in sight with who and when; all done / not everything visible / a failed read', async () => {
  const w = FULL(); w.draw(); await tick(); assert.ok(secs(w).length >= 7); assert.equal(w.find((n) => n.attrs['aria-expanded'] && /^dhG-/.test(n.id)).length, 0);
  assert.match(words(w, 'logistics'), /^Logistics\d+ of \d+ done$/); assert.match(w.text(), /Fire NOC/);
  const all = world({ bk: [{ id: 'b', vendor_id: 'v1', label: 'C', status: 'confirmed' }], ck: [], layout: LAY0, tasks: [{ id: 't', category: 'A', title: 'B', status: 'accepted', crew_id: 'c' }] }); EP.DAYBEFORE.forEach((d) => { all.db.checks[d[0]] = { done: true, by: 'Asha', at: '2026-11-24T04:03:00Z' }; }); all.draw(); await tick();
  assert.match(all.by('dhTot').textContent, /^All \d+ done$/); assert.match(words(all, 'vendors'), /✓ 2 of 2 done|✓ 3 of 3 done/); assert.match(all.text(), /Done by Asha, 9:33 AM/); assert.equal(tops(all).length, 0);
  const deny = world({ deny: ['vendors', 'inventory', 'logistics'], tasks: [{ id: 't', category: 'A', title: 'B', status: 'accepted', crew_id: 'c' }] }); EP.DAYBEFORE.forEach((d) => { deny.db.checks[d[0]] = { done: true }; }); deny.draw(); await tick(); assert.match(deny.by('dhTot').textContent, /^Everything you can see is done/); assert.doesNotMatch(words(deny, 'vendors'), /✓/); assert.doesNotMatch(words(deny, 'logistics'), /✓/);
  const bad = world({ fails: ['checklist'] }); EP.DAYBEFORE.forEach((d) => { bad.db.checks[d[0]] = { done: true }; }); bad.draw(); await tick(); assert.doesNotMatch(words(bad, 'logistics'), /✓/); assert.doesNotMatch(bad.by('dhTot').textContent, /All|Everything/);
});
await t('4c a line: helper words only when opened; everything else in More (keyboard, Escape, focus back)', async () => {
  const w = FULL(); w.draw(); await tick(); assert.doesNotMatch(w.text(), /no loudspeakers|arrival time, set-up/i); w.by('hdbT-line-permits').click(); assert.match(w.text(), /no loudspeakers 10 PM - 6 AM/); assert.equal(w.by('hdbT-line-permits').attrs['aria-expanded'], 'true'); w.draw(); assert.match(w.text(), /no loudspeakers/); w.by('hdbT-line-permits').click(); assert.doesNotMatch(w.text(), /no loudspeakers/);
  assert.deepEqual(menu(w, 'vn-b1'), ['Give a job', 'Open vendors']); assert.deepEqual(menu(w, 'ck-k1'), ['Mark N/A', 'Change owner']); assert.deepEqual(menu(w, 'line-permits'), ['Give to someone', 'Add a line']);
  assert.equal(w.by('hdbMenu-vn-b1').hidden, true); w.by('hdbMore-vn-b1').click(); assert.equal(w.by('hdbMenu-vn-b1').hidden, false); assert.equal(w.by('hdbMore-vn-b1').attrs['aria-expanded'], 'true'); assert.equal(DOC.activeElement.id, 'hdbJob-b1');
  const key = (id, k) => { let n = w.by(id), p = 0; const e = { key: k, preventDefault() { p = 1; }, stopPropagation() {} }; for (; n && n.fire; n = n.parentNode) n.fire('keydown', e); return p; };
  assert.equal(key('hdbJob-b1', 'ArrowDown'), 1); assert.equal(DOC.activeElement.id, 'hdbGo-vn-b1'); w.draw(); assert.equal(w.by('hdbMenu-vn-b1').hidden, false); key('hdbGo-vn-b1', 'Home'); assert.equal(DOC.activeElement.id, 'hdbJob-b1'); key('hdbJob-b1', 'Escape'); assert.equal(w.by('hdbMenu-vn-b1').hidden, true); assert.equal(DOC.activeElement.id, 'hdbMore-vn-b1');
  w.by('hdbNa-k3').click(); await tick(); assert.deepEqual(w.writes, [['chk', 'k3', { status: 'na' }]]);
});
await t('4d one parent line per thing: permits, trucks and guest count hold their Logistics rows; all rows done never ticks it', async () => {
  const w = FULL(); w.draw(); await tick(); const li = (id) => { let n = w.by(id); while (n.tagName !== 'LI') n = n.parentNode; return n; };
  assert.ok(li('epChk-permits').contains(w.by('hdbCk-k1'))); assert.ok(li('epChk-transport').contains(w.by('hdbCk-k3'))); assert.ok(li('epChk-headcount').contains(w.by('hdbCk-k5'))); assert.match(li('epChk-permits').textContent, /1 of 2 in hand/); assert.match(li('epChk-transport').textContent, /0 of 1 ready/); assert.match(li('epChk-headcount').textContent, /180 of 240 guests confirmed/);
  w.by('hdbCk-k1').click(); await tick(); assert.match(li('epChk-permits').textContent, /Rows are done - tick if you agree/); assert.equal(w.by('epChk-permits').attrs['aria-pressed'], 'false'); assert.deepEqual(w.writes.map((x) => x[0]), ['chk']);
  w.by('epChk-transport').click(); await tick(); assert.deepEqual(w.writes[1], ['check', 'transport', true]); assert.ok(li('epChk-transport').contains(w.by('hdbCk-k3')), 'a ticked line with open rows stays in sight'); assert.equal(w.db.ck.find((x) => x.id === 'k3').status, 'open');
  const z = FULL({ deny: ['logistics'] }); z.draw(); await tick(); assert.equal(z.by('hdbCk-k1'), null); assert.doesNotMatch(z.text(), /of \d+ in hand/); assert.equal(z.by('hdbAd-permits'), null);
});
await t('4e stock in one line: need, have, what is only asked, what to reserve', () => {
  const m = (bk) => D.stockWords(D.stockRows({ layout: LAY, reservations: [], checkouts: [], bookings: bk }).rows.filter((r) => r.id === 'i1')[0]);
  assert.equal(m([{ id: 'b', label: 'Chiavari chair', qty: 20, status: 'booked' }]), 'Need 120, have 100 - 20 to reserve');
  assert.equal(m([{ id: 'b', label: 'Chiavari chair', qty: 20, status: 'enquiry' }]), 'Need 120, have 80, 20 asked from a vendor - 20 to reserve', 'asked is not "have"');
  assert.equal(D.stockWords(D.stockRows({ layout: LAY }).rows.filter((r) => r.id === 'i2')[0]), 'Need 12, have 12');
});

await t('3a safety: createElement only, no inline style, no delete, only the known writes; CSS = theme tokens', () => {
  assert.doesNotMatch(JS, /innerHTML|insertAdjacentHTML|outerHTML|document\.write|\.style\b|style=/);
  assert.doesNotMatch(JS, /\.(remove|removeRes|removeNeed|removeLink|deactivateCrew|cancel)\(/); assert.doesNotMatch(JS, /\bcost\b|\badvance\b|day_rate|₹|studioMoney|milestones|finance/);
  const w = [...JS.matchAll(/\.(update|assignTasks|assignTasksVendor|setSchedule|reassign|check|add|reserve\w*)\(/g)].map((m) => m[1]); assert.deepEqual([...new Set(w)].sort(), ['add', 'assignTasks', 'assignTasksVendor', 'check', 'reassign', 'setSchedule', 'update']); assert.deepEqual([...JS.matchAll(/ops\.checks\.(\w+)\(/g)].map((m) => m[1]).sort(), ['addLine', 'cancelLine', 'mark']);
  assert.equal((JS.match(/\.add\(/g) || []).length, (JS.match(/classList\.add\(/g) || []).length, 'add = classList only');
  const rules = CSS.replace(/\/\*[\s\S]*?\*\//g, ''); assert.doesNotMatch(rules, /#[0-9a-f]{3,8}\b/i); assert.match(rules, /--tc-/); assert.match(rules, /min-height:44px/);
});
await t('3b the entry point stays HelmEventPlan.renderDayBefore; scripts are loaded on the three pages; the old list is the fallback', () => {
  assert.match(EPJS, /if \(global\.HelmDayBefore && global\.HelmDayBefore\.render\) return global\.HelmDayBefore\.render\(host, ctx\);/);
  for (const p of ['ops', 'monitor', 'ready']) { const h = read('public/' + p + '.html'); assert.ok(h.indexOf('day-before.css') > h.indexOf('event-plan.css')); assert.ok(h.indexOf('src="day-before.js') > h.indexOf('src="event-plan.js')); assert.equal((h.match(/src="day-before\.js/g) || []).length, 1); }
  const R = read('public/ready.html'); assert.match(R, /readyMask\(x\[0\],x\[1\]\)/); assert.match(R, /noReady:true, plan, tasks, closed:/);
});
console.log('\nr252 day before: ' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
