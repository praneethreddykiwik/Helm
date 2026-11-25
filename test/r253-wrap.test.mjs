// R253 (owner 25 Nov): Wrap-up is done in place (event-wrap.js), the page order of Tasks & Crew, "Latest" never squeezed, four steps in the order of the day.
// The presses themselves are run in a browser (stub data); here: the pure rules, the calls allowed, and the wiring.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const read = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
globalThis.HelmStockFlow = require('../public/stock-flow.js'); require('../public/task-status.js'); require('../public/event-steps.js');
const W = require('../public/event-wrap.js')._pure, PW = globalThis.HelmEventWrap._pure;
const JS = read('public/event-wrap.js'), ES = read('public/event-steps.js'), BRD = read('public/ops-board.js'), OPS = read('public/ops.html'), MONH = read('public/monitor.html'), MON = read('public/monitor.js'), CSS = read('public/ops-board.css'), WCSS = read('public/event-wrap.css'), TD = read('public/teardown.html'), CMD = read('public/command.html');

test('vendors: expected / here / left / did not come, the same two records as Event-day command and Teardown', () => {
  const list = [{ id: 'a', label: 'Cook', status: 'confirmed' }, { id: 'b', label: 'DJ', status: 'booked' }, { id: 'c', label: 'Tent', status: 'delivered' }, { id: 'd', status: 'cancelled' }, { id: 'e', status: 'enquiry' }];
  const r = W.vendorRows(list, [{ id: 'x', ref_id: 'a', status: 'expected', updated_at: '1' }, { id: 'y', ref_id: 'a', status: 'arrived', updated_at: '2' }]);
  assert.deepEqual(r.map((x) => [x.id, x.state, x.arr]), [['a', 'arrived', 'y'], ['b', 'expected', null], ['c', 'left', null]], 'two rows for one vendor: the newest counts');
  assert.equal(W.vendorLine(r), '1 expected · 1 here · 1 left'); assert.deepEqual(W.vendorMoves(r[0]).map((m) => m[1]), ['Left', 'Undo']); assert.deepEqual(W.vendorMoves(r[1]).map((m) => m[1]), ['Arrived', 'Did not come']); assert.deepEqual(W.vendorMoves(r[2]), [], 'returned on Teardown: changed there');
  assert.deepEqual(W.vendorMoves({ state: 'left' }), [['arrived', 'Undo']]); assert.deepEqual(W.vendorMoves({ state: 'no_show' }), [['expected', 'Undo']]);
});
test('stock: a line per check-out, consumables are counted, nothing more than went out', () => {
  const l = W.stockLines([{ id: 'r', item_id: 'i3', qty: 4, status: 'allocated' }], [{ id: 'c1', item_id: 'i1', qty_out: 10, qty_in: 4, status: 'out', issued_to: 'Ravi' }, { id: 'c2', item_id: 'i2', qty_out: 2, qty_in: 2, status: 'returned' }], [{ id: 'i1', name: 'Chairs' }, { id: 'i2', name: 'Lamp' }, { id: 'i3', name: 'Candles', item_kind: 'consumable' }]);
  assert.deepEqual(l.map((x) => [x.name, x.kind, x.left, x.consumable]), [['Candles', 'res', 4, true], ['Chairs', 'co', 6, false], ['Lamp', 'done', undefined, false]]);
  assert.deepEqual(W.count(12, '10', ''), { ok: 10, dmg: 0, miss: 2 }); assert.match(W.count(12, '10', '3').error, /Only 12/); assert.match(W.count(12, '1.5', '').error, /whole/); assert.match(W.count(12, '-1', '').error, /whole/);
});
test('crew: the latest day, still in first; the server keeps the last word', () => {
  const r = W.crewRows({ rows: [{ crew_id: 'a', name: 'A', entries: [{ day: '2', in: '9' }, { day: '1', in: '8', out: '9' }] }, { crew_id: 'b', name: 'B', entries: [] }, { crew_id: 'c', name: 'C', entries: [{ day: '1', in: '8', out: '9' }] }] });
  assert.deepEqual(r.map((x) => [x.id, x.state]), [['a', 'in'], ['b', 'none'], ['c', 'out']]);
  assert.equal(W.plain({ code: '22023', message: 'Times cannot be in the future.' }, 'x'), 'Times cannot be in the future.'); assert.match(W.plain({ code: '42501', message: 'x' }, 'x'), /Your role may not do this/); assert.doesNotMatch(W.plain({ code: 'P0001', message: 'invalid_key' }, 'save'), /invalid_key/);
});
test('progress + what the confirm says; a part that could not be read is named and never counted', () => {
  const ctx = { tasks: [{ id: 1, title: 'Pack up the hall', status: 'completed', planned_start: null }, { id: 2, title: 'Lights', status: 'accepted', crew_id: 'x' }], quote: { eventDate: '2026-11-29', eventTime: '19:00' }, tz: 'Asia/Kolkata' };
  const d = { vendors: [{ id: 'a', label: 'Cook', status: 'confirmed' }, { id: 'b', status: 'delivered' }], arrivals: [], stock: { res: [], cos: [{ item_id: 'i', qty_out: 5, qty_in: 0, status: 'out' }, { item_id: 'j', qty_out: 1, qty_in: 1, status: 'returned' }] }, checklist: [{ status: 'open' }, { status: 'na' }], sheet: { c: { in: '9', out: '' } }, issues: [{ status: 'open' }, { status: 'resolved' }] };
  const p = PW.progress(ctx, d); assert.deepEqual([p.done, p.total, p.skipped], [5, 11, []]);
  assert.equal(PW.openWords(ctx, d), 'Still open: 1 task, 1 vendor not left, 5 pieces of stock out, 1 pack-up note, 1 person not checked out, 1 open issue. ');
  const q = PW.progress(ctx, { ...d, vendors: 'err', stock: 'err', issues: 'err', checklist: 'err', sheet: 'err' }); assert.deepEqual(q.skipped, ['vendors', 'stock', 'pack-up notes', 'crew', 'issues']); assert.equal(q.total, 2);
  assert.match(PW.openWords(ctx, { ...d, stock: 'err' }), /Not checked: stock\. $/);
});
test('only calls the other pages already use; read again before, read back after; one press at a time; nothing deleted, no money', () => {
  const calls = [...new Set([...JS.matchAll(/B\(\)\.([a-zA-Z0-9.]+)\(/g)].map((m) => m[1]))].sort();
  assert.deepEqual(calls, ['auth.handleAuthError', 'bookings.list', 'bookings.update', 'checklist.add', 'checklist.list', 'checklist.update', 'dayops.add', 'dayops.list', 'dayops.setStatus', 'inventory.checkouts.back', 'inventory.checkouts.backV2', 'inventory.checkouts.list', 'inventory.reservations', 'inventory.returnReservation', 'issues.list', 'issues.setStatus', 'moneyIn', 'ops.shifts.officeCheck', 'ops.shifts.timesheet', 'studioLocale', 'vendorRequests.issueLink', 'vendorRequests.linkUrl', 'wrapRecords.newKey', 'wrapRecords.vendor']);
  for (const c of ['bookings.update', 'checklist.add', 'checklist.update', 'returnReservation', 'checkouts.back']) assert.ok(TD.includes(c), 'teardown uses ' + c);
  for (const c of ['dayops.setStatus', 'dayops.add']) assert.ok(CMD.includes(c), 'command uses ' + c);
  assert.doesNotMatch(JS, /innerHTML|insertAdjacentHTML|\.style\b|\.remove\(|rpc\(|supa\b|₹/); assert.equal((JS.match(/return CHANGED/g) || []).length >= 4, true); assert.equal((JS.match(/NOSAVE/g) || []).length >= 5, true);
  assert.match(JS, /if \(BUSY\[k\]\) return/); assert.match(JS, /e\.detail > 1/); assert.match(JS, /navigator\.onLine === false/); assert.match(JS, /"Reason \(required\)"/); assert.match(JS, /Missing or damaged\?/);
  assert.match(ES, /S\.seq\[part\] !== n/, 'an older answer never replaces a newer one');
});
test('wired on both pages, after stock-flow / stock-checkin and before event-steps', () => {
  for (const H of [OPS, MONH]) { const at = (x) => H.indexOf(x); assert.ok(at('stock-flow.js?v=') > 0 && at('stock-checkin.js?v=') > at('stock-flow.js?v=') && at('/event-wrap.js?v=') > at('stock-checkin.js?v=') && at('/event-steps.js?v=') > at('/event-wrap.js?v=')); assert.match(H, /event-wrap\.css\?v=/); assert.match(H, /stock-flow\.css\?v=/); }
  assert.match(OPS, /id="tcVendors"/); assert.match(MONH, /id="monVendors"/); assert.match(BRD, /vendorCard\(\$\("#tcVendors"\), [^\n]*S\.win !== "daybefore"/); assert.match(MON, /vendorCard\(\$\("#monVendors"\)/);
  assert.match(ES, /"Set the event date"/); assert.match(ES, /noDate \? " ghost"/); assert.match(BRD, /dateSet: /);
  assert.doesNotMatch(WCSS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/var\([^)]*\)/g, ''), /#[0-9a-f]{3,8}\b/i, 'theme tokens only');
});
test('page order: needs you now, tasks, the step, issues + latest, crew, plan & reminders', () => {
  const at = (id) => OPS.indexOf('id="' + id + '"');
  const order = ['tcPhase', 'attn', 'work', 'tcPrep', 'flowNext', 'tcDayBefore', 'tcReady', 'tcRun', 'tcFloor', 'tcVendors', 'tcIssues', 'tcActCard', 'tcCrewCard', 'tcPlanRem', 'tcPreDone', 'tcWrap'].map(at); assert.ok(order.every((x) => x > 0)); assert.deepEqual(order, order.slice().sort((a, b) => a - b));
  for (const id of ['evhead', 'tcPhase', 'chips', 'tcQ', 'addBtn', 'view', 'work', 'attn', 'trmLine', 'tcLock', 'trmCardOps', 'remH', 'waSetupNote', 'feed', 'crewList', 'taskCount']) assert.equal(OPS.split('id="' + id + '"').length, 2, id + ' once');
  assert.doesNotMatch(BRD, /Plan locked|Plan open/); assert.match(BRD, /"WhatsApp not set up"/); assert.match(OPS, /OpsBoard\.planRem\(ok===false\)/);
  for (const k of ['late', 'delay', 'in', 'req', 'appr', 'redo']) assert.match(BRD, new RegExp('needRow\\("' + k + '"'));
  assert.match(BRD, /states\.forEach\(function \(x\) \{ g\.head\.appendChild/); assert.match(BRD, /cls: "tc-empty is-row"/);
});
test('Latest: the empty words are not a row of the icon grid; two-up cards are not stretched', () => {
  assert.match(BRD, /cls: "tc-feed-empty"/); assert.match(CSS, /\.tc-feed li\.tc-feed-empty[^{]*\{display:block/); assert.match(CSS, /\.tc-flow\{[^}]*align-items:start/);
});
test('the four steps read in the order of the day everywhere; the sheet opens on the step being viewed', () => {
  assert.deepEqual([...OPS.matchAll(/data-as-step="([a-z]+)"/g)].map((m) => m[1]), ['daybefore', 'pre', 'onday', 'wrapup']); assert.match(BRD, /return S\.addStep \|\| \(handSteps\(\) \? "pre" : S\.win \|\| "pre"\)/);
  assert.match(read('public/page-tours.js'), /the part of the job: Day before, Pre-event, On the event, Wrap-up/);
  for (const f of ['public/ops.html', 'public/ops-board.js', 'public/monitor.js', 'public/task-status.js', 'public/page-tours.js']) assert.doesNotMatch(read(f), /wrapup["'], ?["']daybefore|Wrap-up, Day before\b/, f);
});
