// R271 (owner, 27 Nov 2026): "I already paid the vendor, but it was still showing at the closure that I need to pay the vendor" and
// "make sure everything is synced properly: giving back inventory, reserving, checking in". One vendor money rule (settlement.applyBills)
// for Closure, Payments & invoice, the workspace and Reports; one stock rule (stock-flow.js) for Day before too; SQL 0455 for the server side.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const STORE = read('public/store-api.js'), CLOSURE = read('public/closure.html'), SETTLE = read('public/settlement.html'), DB = read('public/day-before.js');
const SQL = read('supabase/migrations/0455_r271_vendor_paid.sql'), APPLY = read('supabase/APPLY-0455.sql'), MANIFEST = read('supabase/migrations/MANIFEST');
const SF = require('../public/stock-flow.js');

// the store's vendor helpers + the settlement object in a sandbox, with stub reads
function store(bills, costs) {
  const a = STORE.indexOf('  const vbNum = '), b = STORE.indexOf('  const vbTableMissing'), c = STORE.indexOf('  const settlement = {'), d = STORE.indexOf('  /* ---------------- closure, feedback');
  assert.ok(a > 0 && b > a && c > 0 && d > c, 'helpers found');
  const ctx = { BPStore: { todayLocal: () => '2026-11-27' }, vendorBills: { list: async () => bills }, budget: { listCosts: async () => costs || [] }, bookings: { list: async () => [] } };
  vm.createContext(ctx);
  vm.runInContext(STORE.slice(a, b) + STORE.slice(c, d) + '\nthis.settlement = settlement;', ctx);
  return ctx.settlement;
}
const pay = (amount, source) => ({ amount, source: source || 'manual' });

test('1 the live case: invoice RF4553 approved and paid in full (with TDS) - nothing is owed, the vendor is Paid', async () => {
  const bills = [{ id: 'f1', booking_id: 'b1', vendor_id: 'v1', bill_no: 'RF4553', amount: 11800, status: 'open', bill_date: '2026-11-26', vendor_payouts: [pay(10620), pay(1180, 'tds')] }];
  const S = store(bills), sum = { bookings: [{ id: 'b1', vendor_id: 'v1', cost: 10000, advance: null, status: 'confirmed', settled: false }], finalMargin: 0 };
  await S.applyBills(sum, 'q1');
  assert.equal(sum.vendorOutstanding, 0);
  assert.equal(S.vendorState(sum.bookings[0]).k, 'paid');
});
test('2 a part payment leaves the exact rest; a typed advance counts as paid; nothing is counted twice', async () => {
  const bills = [{ id: 'f2', booking_id: 'b2', amount: 10000, status: 'open', vendor_payouts: [pay(4000)] }];
  const S = store(bills), sum = { bookings: [{ id: 'b2', cost: 10000, advance: 3000, status: 'confirmed' }, { id: 'b3', cost: 2000, advance: 500, status: 'booked' }], finalMargin: 0 };
  await S.applyBills(sum, 'q');
  // b2: 10000 billed - 3000 advance - 4000 paid = 3000; b3 (no bill): 2000 - 500 = 1500
  assert.equal(sum.vendorOutstanding, 4500);
  assert.equal(S.vendorState(sum.bookings[0]).owed, 3000);
  // the advance once a payout row (0373 / 0455): the same 3000 is not counted twice
  bills[0].vendor_payouts.push(pay(3000, 'advance'));
  const sum2 = { bookings: [{ id: 'b2', cost: 10000, advance: 3000, status: 'confirmed' }], finalMargin: 0 };
  await store(bills).applyBills(sum2, 'q'); assert.equal(sum2.vendorOutstanding, 3000);
});
test('3 a bill of no booking is owed too (as Who owes what says); a vendor charge counts once; void bills never', async () => {
  const bills = [{ id: 'l1', booking_id: null, vendor_id: 'v9', amount: 900, status: 'open', vendor_payouts: [pay(400)] },
    { id: 'c1', booking_id: null, vendor_id: 'v1', amount: 500, status: 'open', is_charge: true, vendor_payouts: [] },
    { id: 'x1', booking_id: null, amount: 7000, status: 'void', vendor_payouts: [] }];
  const sum = { bookings: [], finalMargin: 0 };
  await store(bills).applyBills(sum, 'q');
  assert.equal(sum.vendorLooseOwed, 500); assert.equal(sum.vendorChargesOwed, 500); assert.equal(sum.vendorOutstanding, 1000);
});
test('4 Closure asks the same rule as Payments & invoice, never the booking cost of a billed vendor, never the larger of two figures', () => {
  const fc = CLOSURE.slice(CLOSURE.indexOf('async function finishClose('), CLOSURE.indexOf('// Gate 2'));
  assert.match(fc, /await BPStore\.settlement\.applyBills\(s,id\)/);
  assert.doesNotMatch(fc, /bills_due|Math\.max\(vo/);
  assert.match(fc, /Owed to vendors: "\+money\(vo\)/);
  assert.match(SETTLE, /on bills not linked to a vendor above \(see Vendor bills\)/);
  assert.match(STORE, /sum\.vendorLooseOwed = Math\.round\(looseOwed \* 100\) \/ 100; out \+= looseOwed;/);
});
test('5 Day before counts given out with the one stock rule: a closed check-out with missing pieces is Missing, not given out', () => {
  const ctx = { HelmStockFlow: SF }; vm.createContext(ctx); vm.runInContext(DB, ctx);
  const rows = ctx.HelmDayBefore.stockRows({ layout: { items: [{ item_id: 'i1', name: 'Chair', needed: 10, held: 10, free: 0 }] }, reservations: [{ item_id: 'i1', qty: 10, status: 'reserved' }],
    checkouts: [{ item_id: 'i1', qty_out: 6, qty_in: 4, status: 'partial' }, { item_id: 'i1', qty_out: 4, qty_in: 1, status: 'out' }, { item_id: 'i1', qty_out: 2, qty_in: 0, status: 'cancelled' }] });
  assert.equal(rows.rows[0].out, 3);
  const all = SF.eventItems({ reservations: [], checkouts: [{ item_id: 'i1', qty_out: 6, qty_in: 4, status: 'partial' }, { item_id: 'i1', qty_out: 4, qty_in: 1, status: 'out' }] })[0];
  assert.equal(all.out, rows.rows[0].out); assert.equal(all.missing, 2);
  // without stock-flow.js on the page (Mark ready) the same answer
  const c2 = {}; vm.createContext(c2); vm.runInContext(DB, c2);
  assert.equal(c2.HelmDayBefore.stockRows({ layout: { items: [{ item_id: 'i1', name: 'Chair', needed: 1 }] }, checkouts: [{ item_id: 'i1', qty_out: 6, qty_in: 4, status: 'partial' }, { item_id: 'i1', qty_out: 4, qty_in: 1, status: 'out' }] }).rows[0].out, 3);
  assert.doesNotMatch(DB, /"packed "/); assert.match(DB, /"given out " \+ fmt\(r\.out\)/);
});
test('6 SQL 0455: additive, safe to run twice, old bodies kept, STOP when unexpected, CHECK rows, MANIFEST + APPLY', () => {
  assert.ok(!/[^\x00-\x7F]/.test(SQL), 'ASCII');
  const code = SQL.replace(/--[^\n]*/g, '');
  assert.doesNotMatch(code, /\bdelete\s+from\b|\btruncate\b|\bdrop\s+(table|column|function|schema|index)\b|\bupdate\s+public\.|alter\s+table/i);
  assert.match(SQL, /_r22_close_checks__pre0455/); assert.match(SQL, /_r447_state__pre0455/); assert.match(SQL, /raise exception 'STOP 0455: the closure checklist has an unexpected body/);
  assert.match(SQL, /if position\('r271-0455' in v_def\) > 0 then return; end if;/);
  assert.match(SQL, /exception when others then\s+raise warning 'r271-0455/);
  assert.match(SQL, /values \(455, '0455_r271_vendor_paid'\) on conflict \(num\) do nothing/);
  assert.equal((SQL.match(/^ {2}\('0\d /gm) || []).length, 5);
  assert.ok(APPLY.includes(SQL.trim())); assert.match(APPLY, /^begin;$/m); assert.match(APPLY, /^commit;$/m);
  assert.match(MANIFEST, /^forward {2}supabase\/migrations\/0455_r271_vendor_paid\.sql$/m);
});
test('7 no new HTML sinks, inline styles or em dashes in the changed lines', () => {
  const fc = CLOSURE.slice(CLOSURE.indexOf('// R271'), CLOSURE.indexOf('const money=n=>evTax', CLOSURE.indexOf('// R271')));
  assert.ok(fc.length > 100); assert.doesNotMatch(fc, /innerHTML|—/);
  const ob = DB.slice(DB.indexOf('// R271'), DB.indexOf('function resBy'));
  assert.doesNotMatch(ob, /innerHTML|—|style/);
});
