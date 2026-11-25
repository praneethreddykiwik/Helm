// R258i (owner, 25 Nov): Inventory gives out right in the row, Wrap-up in tabs, vendor items handed back (0444), no A- / A+ on the monitor.
// Pure rules + the wiring; the presses run in a browser with stub data, the SQL in tests/db/r258-wrap-records-0444.sql.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), read = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
globalThis.HelmStockFlow = require('../public/stock-flow.js'); require('../public/task-status.js'); require('../public/event-steps.js');
const W = require('../public/event-wrap.js')._pure, E = globalThis.HelmEventWrap._pure, SC = require('../public/stock-checkin.js');
const INV = read('public/inventory.html'), IL = read('public/inventory-layout.js'), JS = read('public/event-wrap.js'), ES = read('public/event-steps.js'), TD = read('public/teardown.html'), STORE = read('public/store-api.js'), SQL = read('supabase/migrations/0444_r258_wrap_records.sql'), MIG = read('supabase/migrations/MANIFEST');

test('problem: damaged / missing / still out are counted, the rest came back OK; nothing impossible is saved', () => {
  const p = SC.problemPlan({ out: 10, prior: 2, damaged: '1', missing: '2', still: '', photoProof: true });
  assert.deepEqual([p.left, p.ok, p.dmg, p.miss, p.part, p.photoNeeded], [8, 5, 1, 2, false, true]);
  const s = SC.problemPlan({ out: 10, damaged: 1, still: 4 }); assert.deepEqual([s.ok, s.part, s.stillOut, s.miss], [5, true, 4, 0]);
  assert.equal(SC.problemPlan({ out: 5, still: 5 }).none, true); assert.match(SC.problemPlan({ out: 5 }).error, /Back OK/); assert.match(SC.problemPlan({ out: 5, missing: 1, still: 1 }).error, /Still out/);
  assert.match(SC.problemPlan({ out: 5, damaged: 6 }).error, /Only 5/); assert.match(SC.problemPlan({ out: 5, damaged: '1.5' }).error, /whole/); assert.match(SC.problemPlan({ out: 5, damaged: '-1' }).error, /whole/);
});
test('wrap-up: 12 items: 10 back, 1 missing, 1 still out; tabs in order, each with its state; nothing empty', () => {
  const cos = Array.from({ length: 10 }, (_, i) => ({ id: 'b' + i, item_id: 'i' + i, qty_out: 2, qty_in: 2, status: 'returned' })).concat([{ id: 'm', item_id: 'm', qty_out: 5, qty_in: 4, status: 'partial' }, { id: 'o', item_id: 'o', qty_out: 5, qty_in: 0, status: 'out' }]);
  assert.equal(E.stockWords([{ item_id: 'r', qty: 4, status: 'reserved' }], cos), '12 items: 10 back, 1 missing, 1 still out'); assert.equal(E.stockWords([{ item_id: 'r', qty: 4, status: 'reserved' }], []), '');
  const rows = [{ id: 'tasks', tone: 'ok', status: 'All done' }, { id: 'vendors', tone: 'warn', status: '1 not left yet' }, { id: 'stock', tone: 'ok', status: 'All back' }, { id: 'teardown', tone: 'warn', status: '0 of 1 done' }, { id: 'issues', tone: 'warn', status: '2 open' }];
  assert.deepEqual(E.tabsOf(rows).map((t) => [t.id, t.tone, t.status]), [['stock', 'ok', 'All back'], ['vendors', 'warn', '1 not left yet'], ['tasks', 'warn', '2 open issues']]);
  const r = E.rowsOf({ quoteId: 'q', tasks: [] }, { checklist: [], vendors: [{ id: 'b', status: 'confirmed', label: 'Cook' }], arrivals: [{ ref_id: 'b', status: 'left' }], records: { vendor: { b: { state: 'problem' } } } });
  assert.ok(!r.some((x) => x.id === 'teardown'), 'no empty pack-up list');
  assert.equal(E.notBackV([{ id: 'b', status: 'confirmed' }, { id: 'c', status: 'cancelled' }], { vendor: { b: { state: 'not_returned' }, c: { state: 'problem' } } }).length, 1); assert.equal(E.notBackV([{ id: 'b' }], { vendor: { b: { state: 'undo' } } }).length, 0);
  assert.match(E.openWords({ tasks: [], quote: {} }, { vendors: [{ id: 'b', status: 'delivered' }], records: { vendor: { b: { state: 'problem' } } } }), /1 vendor with items not all returned/);
});
test('vendor answers: an Undo is no answer but stays "seen"; n of m; invoice states; our stock with them', () => {
  const rec = { vendor: { a: { id: '1', state: 'problem', qty_total: 120, qty_back: 118 }, b: { id: '2', state: 'undo' } } };
  assert.equal(W.retOf(rec, 'a').id, '1'); assert.equal(W.retOf(rec, 'b'), null); assert.equal(W.seenOf(rec, 'b'), '2'); assert.equal(W.seenOf(rec, 'z'), null); assert.equal(W.retOf(null, 'a'), null);
  const inv = (r, b) => W.invoiceOf(r, b || { id: 'bk', vendor_id: 'v' }).k;
  assert.equal(inv([]), 'none'); assert.equal(inv([{ status: 'rejected', booking_id: 'bk' }, { status: 'cancelled', booking_id: 'bk' }]), 'none'); assert.equal(inv([{ status: 'sent', booking_id: 'bk' }]), 'asked'); assert.equal(inv([{ status: 'accepted', booking_id: 'bk' }]), 'waiting');
  assert.equal(inv([{ status: 'accepted', vendor_id: 'v', invoices_open: 1 }]), 'received'); assert.equal(inv([{ status: 'accepted', booking_id: 'bk', invoices_queried: 1 }]), 'query'); assert.equal(inv([{ status: 'accepted', booking_id: 'bk', invoices_approved: 1 }]), 'approved');
  assert.equal(inv([{ status: 'accepted', booking_id: 'other', vendor_id: 'v' }]), 'none', 'another booking of the same vendor is not this one');
  assert.match(W.invoiceOf([{ id: 'r', status: 'accepted', booking_id: 'bk', invoices_approved: 1, invoices: [{ status: 'approved', pay_status: 'paid' }] }], { id: 'bk' }).t, /paid/);
  assert.deepEqual(W.oursWith({ cos: [{ item_id: 'i', qty_out: 8, qty_in: 2, status: 'out', issued_to: ' sri caterers' }, { item_id: 'i', qty_out: 1, status: 'returned', issued_to: 'Sri Caterers' }] }, [{ id: 'i', name: 'Lamp' }], 'Sri Caterers'), ['6 Lamp']);
});
test('notes from the day: issues, extras, stock and vendors, oldest first, an undone answer says so', () => {
  const n = W.dayNotes({ issues: [{ title: 'Fuse', status: 'resolved', created_at: '2026-11-25T10:00:00Z' }], extras: { items: [{ what: 'Plates', at: '2026-11-25T09:00:00Z', by: 'Priya' }, { what: 'x', cancelled_at: 'y' }] }, stock: { cos: [{ item_id: 'i', qty_out: 5, qty_in: 4, qty_damaged: 1, status: 'partial', checked_in_at: '2026-11-25T11:00:00Z' }] },
    records: { stock: [{ at: '2026-11-25T11:01:00Z', label: 'Lamp', note: 'fell' }], log: [{ id: '3', ref: 'b', state: 'returned', at: '2026-11-25T12:02:00Z' }, { id: '2', ref: 'b', state: 'undo', at: '2026-11-25T12:01:00Z' }, { id: '1', ref: 'b', label: 'Cook', state: 'problem', note: 'broken', qty_total: 3, qty_back: 2, at: '2026-11-25T12:00:00Z' }] } }, { i: 'Lamp' });
  assert.deepEqual(n.map((x) => x.kind), ['Extra', 'Issue', 'Stock', 'Stock', 'Vendor']); assert.equal(n[1].text, 'Fuse (sorted)'); assert.equal(n[2].text, 'Lamp: 1 missing, 1 damaged'); assert.equal(n[4].text, 'Cook: Returned with a problem (2 of 3) - broken (undone)');
  assert.deepEqual(W.dayNotes(null), []); assert.deepEqual(W.dayNotes({ issues: 'err', stock: 'err', records: 'err', extras: 'err' }), []);
});
test('inventory: give out in the row (this event first), several to one person, the same guarded call; back OK / problem / undo', () => {
  assert.match(INV, /grp\("On this event",opts\.filter\(on\)/); assert.match(INV, /BPStore\.people\.options\(\)/); assert.match(INV, /checkouts\.outSmart\(itemId, quoteId, qty, to\.name, to\.crewId, note\|\|null, false\)/);
  assert.match(INV, /if\(giveBusy\|\|!lines\.length\) return; giveBusy=true/); assert.match(INV, /id="sgGo"/); assert.match(INV, /data-g="due"/); assert.match(INV, /backV2\(c\.id,\{ok:left,damaged:0\}\)/); assert.match(INV, />Undo<\/button>/); assert.doesNotMatch(INV, /Cancel check-out|Checked out to|Issued to</);
  assert.match(IL, /"Reserve and give to\.\.\."/); assert.match(IL, /linkAndReserve\(block, q\)\.then\(function \(d\) \{\s*if \(!d\.reserved\)/); assert.match(INV, /peopleSelect, pickOf, give:/);
  assert.match(read('public/stock-flow.css'), /@media \(max-width:640px\)\{\n  \.sg-tbl/); assert.match(read('public/stock-flow.css'), /min-height:44px/);
});
test('wired: the store calls, teardown words, nothing sent by itself, print only this list', () => {
  for (const f of ['event_wrap_records_get', 'event_vendor_return_set', 'stock_return_note']) { assert.ok(STORE.includes('"' + f + '"')); assert.ok(SQL.includes('function public.' + f)); }
  assert.match(STORE, /extras|wrapRecords, extras/); assert.match(TD, /Returned with a problem/); assert.match(TD, /data-bok=/); assert.doesNotMatch(TD, /Mark returned\/exited/);
  assert.match(JS, /Nothing is sent by itself/); assert.doesNotMatch(JS, /sendEmail|whatsapp|wa\.me/i); assert.match(read('public/event-wrap.css'), /body\.hwd-printing>\*:not\(\.hwd-print\)/); assert.match(ES, /role: "tablist"/); assert.match(ES, /ArrowRight/);
  assert.doesNotMatch(read('public/event-delay.js'), /give, mv, lock,/, 'a removed variable broke Tasks & Crew while something was late');
});
test('0444: additive, insert-only, pinned, revoked, read-only check, listed', () => {
  const code = SQL.replace(/--[^\n]*/g, ''); assert.doesNotMatch(code, /\b(update|delete from|truncate|drop)\s+(public|table|function)/i); assert.equal((code.match(/security definer set search_path = ''/g) || []).length, 3); assert.match(code, /enable row level security/);
  assert.ok(read('supabase/APPLY-0444.sql').includes(SQL.trimEnd())); assert.ok(MIG.trimEnd().split('\n').includes('forward  supabase/migrations/0444_r258_wrap_records.sql')); assert.match(read('scripts/db-test/run-all.sh'), /R258-WRAP-RECORDS-0444: ALL PASS \\\(20\/20\\\)/);
  assert.doesNotMatch(SQL, /create temp|set_config/i); assert.match(SQL, /pg_advisory_xact_lock/); for (const f of ['test/release-1019.test.mjs', 'test/release-1020.test.mjs']) assert.ok(read(f).includes("'0444'"));
});
