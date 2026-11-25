// R261-B (owner's live test, 25 Nov 2026): the sum behind "81", what was really asked, vendor notices open the request, files open, one clear vendor status,
// settled is never shown without a payment, what vendors charge for missing / broken items, "left" the same everywhere. SQL: tests/db/r261-vendor-money-0450.sql.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), read = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8'), J = (x) => JSON.parse(JSON.stringify(x));
const L = require('../public/inventory-layout.js'), VS = require('../public/vendor-state.js'), VC = require('../public/vendor-charges.js'), VF = require('../public/vendor-flow.js');
const STORE = read('public/store-api.js'), SET = read('public/settlement.html'), TD = read('public/teardown.html'), UI = read('public/vendor-requests-ui.js'), FLOW = read('public/vendor-flow.js'), SQL = read('supabase/migrations/0450_r261_vendor_money.sql');
const cut = (a, b) => { const i = STORE.indexOf(a); assert.ok(i > 0, a); const j = STORE.indexOf(b, i); return STORE.slice(i, j); };

const type = (per, mode, o) => ({ layout_type: 'table', label: 'Round Table', objects: 9, seats: 70, links: [{ item_id: 'i', per_object: per, count_mode: mode, needed: Math.ceil((mode === 'seats' ? 70 : 9) * per) }], ...o });
test('B1: the sum behind the number, and the question when one table takes several tables', () => {
  const it = { item_id: 'i', name: 'Round Table' };
  assert.equal(L.sumOf(it, [type(9, 'objects')]).text, '9 tables × 9 each = 81'); assert.deepEqual(J(L.sumOf(it, [type(9, 'objects')]).odd), [{ type: 'table', label: 'Round Table', per: 9, word: 'table' }]);
  assert.deepEqual(J(L.sumOf(it, [type(1, 'objects')])), { text: '', odd: [] }, '1 per table needs no sum');
  const ch = { item_id: 'i', name: 'Chiavari chair' }; assert.equal(L.sumOf(ch, [type(8, 'objects')]).text, '9 tables × 8 each = 72'); assert.deepEqual(J(L.sumOf(ch, [type(8, 'objects')]).odd), [], '8 chairs per table is fine');
  assert.equal(L.sumOf(it, [type(2, 'seats')]).text, '70 seats × 2 each = 140'); assert.equal(L.sumOf(it, [type(9, 'objects', { objects: 1 })]).text.slice(0, 7), '1 table');
  assert.equal(L.sumOf({ item_id: 'x', name: 'Other' }, [type(9, 'objects')]).text, ''); assert.equal(L.sumOf(it, null).text, '');
  assert.match(read('public/inventory-layout.js'), /"How many of this item for ONE "/); assert.match(read('public/inventory-layout.js'), /setLink\(o\.type, it\.item_id, 1, "objects"\)/);
});
test('B2: what was really asked is said, with what is more than needed', () => {
  const r = { short: true, toBorrow: 51 }, l = (q, st) => [{ qty: q, status: st || 'enquiry' }];
  assert.deepEqual(J(L.missText(r, L.coverOf(51, l(81)), l(81))), { text: '81 asked', cls: 'amber', sub: '51 missing · 81 asked (30 more than needed)' });
  assert.deepEqual(J(L.missText(r, L.coverOf(51, l(51)), l(51))), { text: '51 asked', cls: 'amber' }); assert.equal(L.missText(r, L.coverOf(51, l(20)), l(20)).text, '31 missing');
  assert.equal(L.missText(r, L.coverOf(51, l(81, 'confirmed')), l(81, 'confirmed')).text, '81 from vendor'); assert.equal(L.missText({ short: false, covered: true }, {}, []).text, 'Covered');
  assert.match(read('public/inventory-layout.js'), /qty: Math\.ceil\(r\.toBorrow\) \}, true\)/, 'the request starts at what is missing'); assert.match(read('public/stock-vendor.js'), /more than needed/);
});
test('B3: a vendor notice opens that request; the other vendor links open the vendors of this event', async () => {
  const { notifLink } = await import('data:text/javascript,' + encodeURIComponent(read('supabase/functions/comms-dispatch/deeplink.js'))), q = '11111111-1111-4111-8111-111111111111', rq = '22222222-2222-4222-8222-222222222222';
  const n = (d) => notifLink({ kind: 'event_reminder', quote_id: q, detail: d });
  assert.equal(n({ source: '0256', vendor_request_id: rq }), 'vendors.html?tab=requests&quote=' + q + '&req=' + rq); assert.equal(n({ source: '0256', vendor_request_id: '"><x' }), 'vendors.html?tab=requests&quote=' + q);
  assert.equal(n({ source: '0269' }), 'runsheet.html?quote=' + q); assert.equal(n({}), 'event.html?id=' + q); assert.match(STORE, /d\.source === "0256"/);
  assert.match(UI, /qs\.get\("req"\)/); assert.match(UI, /scrollIntoView/); assert.match(read('public/monitor.js'), /\["Vendors", "vendors\.html\?tab=requests&quote=" \+ q\]/);
});
test('B5: the tab is opened inside the click, then sent to the link; a blocked one gets a dialog', () => {
  const f = FLOW.slice(FLOW.indexOf('api.openFile'), FLOW.indexOf('function openFile(path')); assert.ok(f.indexOf('global.open("about:blank"') < f.indexOf('.then(get)')); assert.match(f, /w\.opener = null/); assert.match(f, /w\.location\.replace\(u\)/); assert.match(f, /Open the file/);
  assert.doesNotMatch(FLOW.replace(f, ''), /global\.open\(u/); assert.match(UI, /F\(\)\.openFile\(/);
});
test('B6: one clear status, to Closed; what is really paid decides', () => {
  assert.deepEqual(J(VF.STEPS), ['Asked', 'Available', 'Confirmed', 'Invoice asked', 'Invoice received', 'Approved', 'Paid', 'Closed']);
  const r = { status: 'accepted', state: 'confirmed' }; assert.equal(VF.info({ ...r, pay: { k: 'paid' } }).text, 'Paid and closed'); assert.equal(VF.info({ ...r, pay: { k: 'closed' } }).text, 'Closed without payment'); assert.equal(VF.info({ ...r, pay: { k: 'unrecorded' } }).text, 'Marked settled - no payment recorded');
  assert.equal(VF.info({ ...r, pay: { k: 'owed' } }).text, 'Confirmed'); assert.equal(VF.info({ ...r, state: 'invoice_received', invoices_open: 1, pay: { k: 'paid' } }).k, 'invoice_received', 'a waiting invoice comes first');
  assert.match(UI, /vrq-fn/); assert.match(UI, /r\.pay\.k === "owed" \|\| r\.pay\.k === "unrecorded"/); assert.match(UI, /"Review invoice"/); assert.match(UI, /"Record payment"/); assert.match(UI, /"Close without payment"/);
});
test('B6b: settled is never shown without saying whether it was paid', () => {
  const vs = new Function('return {' + cut('vendorState(b) {', '// R257: agreed vendors').replace(/,\s*$/, '') + '}')().vendorState, b = (o) => ({ status: 'confirmed', cost: 32900, ...o });
  assert.deepEqual(vs(b({ settled: true })), { k: 'unrecorded', owed: 32900, paid: 0 }); assert.equal(vs(b({ settled: true, settled_reason: 'for free' })).k, 'closed'); assert.equal(vs(b({})).k, 'owed');
  assert.equal(vs(b({ _out: 0, _paid: 32900, _cost: 32900 })).k, 'paid'); assert.deepEqual(vs(b({ settled: true, _out: 100, _paid: 32800, _cost: 32900 })), { k: 'unrecorded', owed: 100, paid: 32800 }); assert.equal(vs(b({ cost: null })).k, 'none');
  assert.equal(vs(b({ status: 'enquiry', settled: true })).k, 'none'); assert.equal(vs({ status: 'booked', cost: 500, advance: 500 }).k, 'paid');
  assert.doesNotMatch(SET, /data-settle=/); assert.match(SET, /Marked settled - no payment recorded/); assert.match(SET, /Review invoice/); assert.match(SET, /HelmVendorFlow\.payBooking/); assert.match(SET, /HelmVendorFlow\.closeNoPay/);
  assert.match(STORE, /Closing without a payment needs the latest database update/);
});
test('B7: what a vendor charges: the form, the totals, once in the profit', () => {
  const P = VC._pure, ok = { label: 'Table', qty: '1', amount: '1,500.50', note: '', state: 'agreed' };
  assert.deepEqual(P.check(ok).row, { label: 'Table', qty: 1, amount: 1500.5, note: null, state: 'agreed' }); for (const [k, v] of [['label', ' '], ['amount', '0'], ['amount', '-4'], ['amount', '1.234'], ['amount', 'x'], ['qty', '-1'], ['state', ''], ['state', 'void'], ['note', '<b>']]) assert.equal(P.check({ ...ok, [k]: v }).field, k, k + v);
  assert.deepEqual(P.suggest([{ label: 'Table', missing: 1, damaged: 2, note: 'leg' }, { label: 'Table', damaged: 1 }, { missing: 4 }, { label: 'OK', missing: 0 }]), [{ label: 'Table', qty: 4, note: 'leg' }]);
  const st = { rows: [{ booking: 'b', state: 'agreed', amount: 500, paid: 200 }, { booking: 'b', state: 'asked', amount: 70 }, { booking: 'b', state: 'in_invoice', amount: 9 }, { booking: 'b', state: 'void', amount: 8 }, { booking: 'c', state: 'agreed', amount: 1 }] };
  assert.deepEqual(P.total(st, 'b'), { agreed: 500, asked: 70, paid: 200, n: 2 }); assert.deepEqual(P.total(null, 'b'), { agreed: 0, asked: 0, paid: 0, n: 0 });
  const src = 'const vbNum = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };' + cut('const vbLineVal', 'function vendorPnlCalc') + cut('function vendorPnlCalc', '// paid / part / unpaid'), calc = new Function(src + 'return vendorPnlCalc')();
  const bk = [{ id: 'b', status: 'confirmed', cost: 32900 }], ch = { id: 'x', amount: 500, is_charge: true };
  assert.equal(calc({ bookings: bk, bills: [ch] }).vendors, 33400); assert.equal(calc({ bookings: bk, bills: [ch], costs: [{ kind: 'vendor', estimated: 400 }] }).vendors, 33800, 'never instead of a typed line'); assert.equal(calc({ bookings: bk, bills: [ch, { id: 'y', amount: 600 }], costs: [{ kind: 'vendor', estimated: 1000 }] }).vendors, 34400);
  assert.match(SQL, /'category', 'damages'/); assert.match(SQL, /'event_vendor_charges'/); assert.doesNotMatch(SQL, /\bdelete from\b|\bdrop table\b/i); assert.match(SQL, /values \(450, '0450_r261_vendor_money'\)/);
  for (const f of ['event-wrap.js', 'settlement.html', 'teardown.html', 'vendor-requests-ui.js']) assert.match(read('public/' + f), /HelmVendorCharges/, f);
});
test('C5: left is left everywhere', () => {
  const arr = [{ id: 'a1', ref_id: 'b', status: 'left', left_at: '2026-11-25T17:53:00Z', updated_at: '2026-11-25T17:53:00Z' }, { id: 'a0', ref_id: 'b', status: 'arrived', updated_at: '2026-11-25T10:00:00Z' }];
  const s = VS.of({ id: 'b', status: 'confirmed' }, arr); assert.equal(s.state, 'left'); assert.equal(s.arr, 'a1'); assert.match(s.text, /^Left .*11:23/i); assert.equal(s.exited, false);
  assert.equal(VS.of({ id: 'b', status: 'delivered' }, []).state, 'left'); assert.equal(VS.of({ id: 'b', status: 'delivered' }, [{ ref_id: 'b', status: 'no_show' }]).state, 'no_show'); assert.equal(VS.of({ id: 'z', status: 'booked' }, arr).text, 'Not arrived yet'); assert.equal(VS.of({ id: 'b' }, null).state, 'expected');
  assert.match(TD, /HelmVendorState/); assert.match(TD, /data-vmove="left"/); assert.doesNotMatch(TD, /Marked Left on Event-day command/); assert.match(TD, /wrapRecords\.vendor\(id,bb\.id,\{ state:"returned"/);
  globalThis.HelmStockFlow = globalThis.HelmStockFlow || require('../public/stock-flow.js'); require('../public/task-status.js'); require('../public/event-steps.js'); const E = globalThis.HelmEventSteps._pure, ctx = { quoteId: 'q', tasks: [], autoWin: 'wrapup', quote: {} }, d = (state) => ({ vendors: [{ id: 'b', status: 'delivered' }], arrivals: [], records: { vendor: { b: { state } } } });
  assert.equal(globalThis.HelmEventWrap._pure.rowsOf(ctx, d('problem')).find((r) => r.id === 'vendors').status, '1 with a problem'); assert.equal(globalThis.HelmEventWrap._pure.rowsOf(ctx, d('not_returned')).find((r) => r.id === 'vendors').status, '1 not all returned'); assert.ok(E);
});
test('the pages load the new files; page tours know them', () => {
  for (const [f, s] of [['vendors.html', 'vendor-state.js'], ['vendors.html', 'vendor-charges.js'], ['settlement.html', 'vendor-flow.js'], ['settlement.html', 'vendor-charges.js'], ['teardown.html', 'vendor-state.js'], ['teardown.html', 'vendor-charges.js'], ['resources.html', 'vendor-state.js']]) assert.ok(read('public/' + f).includes('/' + s + '?v='), f + ' ' + s);
  for (const f of ['vendor-charges.js', 'vendor-state.js']) assert.doesNotMatch(read('public/' + f), /innerHTML|insertAdjacentHTML|\.style\b/, f);
  assert.match(read('public/page-tours.js'), /Charge from the vendor/);
});
