// R260 (owner, 25 Nov): vendor items are checked in on Pre-event and out on Wrap-up (0448, vendor-items.js). Pure rules + the wiring; the presses run in a
// browser with stub data, the SQL in tests/db/r260-vendor-items-0448.sql.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), read = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
globalThis.HelmStockFlow = require('../public/stock-flow.js'); require('../public/task-status.js'); const VI = require('../public/vendor-items.js'); require('../public/event-steps.js');
const V = VI._pure, E = globalThis.HelmEventWrap._pure, P = globalThis.HelmEventSteps._pure, W = require('../public/event-wrap.js')._pure;
const SQL = read('supabase/migrations/0448_r260_vendor_items.sql'), JS = read('public/vendor-items.js'), WRAP = read('public/event-wrap.js'), STORE = read('public/store-api.js');
const rec = (expected, ok, damaged, o) => ({ id: 'r', state: expected - ok - damaged > 0 ? 'missing' : damaged ? 'damaged' : 'ok', expected, ok, damaged, missing: Math.max(expected - ok - damaged, 0), at: '2026-11-25T10:00:00Z', by: 'Asha', ...o });
const item = (o) => ({ key: 'k', label: 'Chairs', expected: 12, listed: true, in: null, out: null, ...o });

test('counting: what is missing is worked out, a note is needed for it; nothing impossible', () => {
  assert.deepEqual(V.count(12, '12', '', 'in'), { ok: 12, damaged: 0, missing: 0, note: false }); assert.deepEqual(V.count(12, '10', '1', 'in'), { ok: 10, damaged: 1, missing: 1, note: true });
  assert.equal(V.count(12, '15', '', 'in').missing, 0); assert.match(V.count(12, '121', '', 'in').error, /far more/); assert.match(V.count(12, '13', '', 'out').error, /Only 12 came in/); assert.match(V.count(12, '11', '2', 'out').error, /Only 12/);
  for (const bad of ['-1', 'x', '1.234', '1e3']) assert.match(V.count(12, bad, '', 'in').error, /0 or more/); assert.equal(V.count(12.5, '12,5', '', 'in').missing, 0); assert.equal(V.count(0.3, '0.1', '0.2', 'in').missing, 0); assert.equal(V.count(5, '', '', 'out').missing, 5);
});
test('in plain words, in and out', () => {
  assert.equal(V.words(item({ unit: 'pcs' }), 'in'), 'Expected 12 pcs'); assert.equal(V.words(item({ in: rec(12, 10, 1) }), 'in'), 'Got 11 of 12, 1 damaged, 1 missing');
  assert.equal(V.words(item({ in: rec(12, 12, 0) }), 'out'), '12 came in'); assert.equal(V.words(item({ in: rec(12, 12, 0), out: rec(12, 11, 1) }), 'out'), '12 came in, 11 back, 1 broken'); assert.equal(V.words(item({ in: rec(12, 12, 0), out: rec(12, 10, 1) }), 'out'), '12 came in, 10 back, 1 broken, 1 not returned');
  assert.equal(V.words(item(), 'out'), 'Not checked in (expected 12)'); assert.equal(V.words(item({ out: rec(12, 12, 0) }), 'out'), '12 expected, 12 back');
  assert.equal(V.base(item({ in: rec(12, 10, 1) })), 11); assert.equal(V.base(item()), 12); assert.deepEqual(V.pill(item({ in: rec(12, 10, 2) }), 'in'), ['no_show', '2 damaged']); assert.deepEqual(V.pill(item({ out: rec(12, 11, 0) }), 'out'), ['no_show', '1 not returned']);
});
const st = { full: true, vendors: {
  a: { vendor: 'Sri Rentals', vendor_id: 'v1', status: 'confirmed', arrival: 'arrived', problems: [{ phase: 'in', label: 'Tables', missing: 1, damaged: 0, note: 'one short', at: '1', by: 'Asha' }, { phase: 'out', label: 'Chairs', missing: 0, damaged: 1, note: 'leg', at: '2' }], items: [item({ in: rec(12, 12, 0), out: rec(12, 11, 1) }), item({ key: 't', in: rec(5, 4, 0) }), item({ key: 'z' })] },
  b: { vendor: 'Sri Rentals', vendor_id: 'v1', status: 'confirmed', arrival: 'arrived', items: [item({ in: rec(3, 0, 0) })], problems: [] },
  c: { vendor: 'DJ', status: 'booked', arrival: 'no_show', items: [item()], problems: [] }, d: { vendor: 'Van', status: 'delivered', items: [item()], problems: [] }, e: { vendor: 'Flowers', status: 'booked', items: [], problems: [{ phase: 'in', label: null, state: 'missing', missing: null, damaged: null, note: 'roses' }] } } };
test('one event: 3 of 5 items in, who is open, what Wrap-up counts; did not come and no list are left out', () => {
  const s = V.sumOf(st); assert.deepEqual([s.total, s.done, s.missing], [5, 3, 4]); assert.equal(V.inLine(s), '3 of 5 items in, 4 missing'); assert.deepEqual(V.openWords(s), ['Sri Rentals (3 of 4 in)']); assert.deepEqual([s.outTotal, s.outDone], [2, 1], 'not checked in, or came with nothing = not asked for');
  assert.equal(V.sumOf(null), null); assert.equal(V.sumOf({ full: false, vendors: {} }), null); assert.equal(V.inLine(V.sumOf({ full: true, vendors: {} })), ''); assert.equal(V.inLine({ total: 1, done: 0 }), '0 of 1 item in');
});
test('pre-event, wrap-up and settlement say it', () => {
  VI.put('q1', st); const s = P.preSummary({ quoteId: 'q1', quote: {}, tasks: [] }); assert.deepEqual(s.vitems, ['Sri Rentals (3 of 4 in)']); assert.ok(P.preLines(s).some((l) => l[1] === '1 vendor with items not checked in: Sri Rentals (3 of 4 in)')); assert.match(P.confirmPre('E1', s), /Vendor items not checked in: Sri Rentals \(3 of 4 in\)\. The event moves to Event Day/);
  assert.equal(P.preSummary({ quoteId: 'none', quote: {}, tasks: [] }).vitems, undefined, 'not read = nothing said');
  const d = { vendors: [{ id: 'a', status: 'delivered' }], records: { vendor: {} }, vitems: st }, ctx = { quoteId: 'q1', tasks: [], autoWin: 'wrapup', quote: {} };
  assert.deepEqual(E.progress(ctx, d), { done: 2, total: 3, skipped: [] }); assert.equal(E.rowsOf(ctx, d).filter((r) => r.id === 'vendors')[0].status, '1 item to check out'); assert.match(E.openWords(ctx, d), /1 vendor item not checked out/);
  assert.deepEqual(E.progress(ctx, { vendors: d.vendors }), { done: 1, total: 1, skipped: [] }, 'without 0448 as before'); assert.equal(E.rowsOf(ctx, { vendors: d.vendors }).filter((r) => r.id === 'vendors')[0].status, 'All left');
  assert.deepEqual(V.problemLine(st.vendors.a.problems), { text: 'Items: 1 missing on arrival, 1 broken at return', notes: ['Tables, on arrival: one short', 'Chairs, at return: leg'] }); assert.equal(V.problemLine(st.vendors.e.problems).text, 'Items: some missing on arrival'); assert.equal(V.problemLine([]), null);
  const n = W.dayNotes({ vitems: st }); assert.equal(n.length, 3); assert.ok(n.some((x) => x.text === 'Sri Rentals: Chairs - 1 broken at return - leg')); assert.deepEqual(V.notes({ full: false, vendors: {} }), []);
});
test('wired: both pages, the same file; works without 0448; no money, no stock, no status', () => {
  for (const p of ['ops', 'monitor']) { const h = read('public/' + p + '.html'); assert.ok(h.indexOf('vendor-items.js') > h.indexOf('event-wrap.js') && h.indexOf('vendor-items.js') < h.indexOf('event-steps.js')); assert.match(h, /vendor-items\.css/); }
  const s = read('public/settlement.html'); assert.match(s, /data-vi="\$\{esc\(b\.id\)\}"/); assert.match(s, /HelmVendorItems\.lines\(id,\$\("#vendBody"\)\)/);
  assert.match(STORE, /rpc\("event_vendor_items_get"/); assert.match(STORE, /rpc\("event_vendor_items_set"/); assert.match(STORE, /async items\(quoteId\)[^\n]*rpcMissing\(e\)\) return null/);
  assert.match(WRAP, /if \(rows\.length && !\(VI\(\) && VI\(\)\.preList\(/); assert.match(JS, /if \(!st\) return false/); assert.doesNotMatch(JS, /innerHTML|insertAdjacentHTML|\bcost\b\s*[:=]|bookings\.update|checkouts\./);
  assert.match(JS, /"All items arrived"/); assert.match(JS, /"All handed back"/); assert.match(JS, /\+ Add an item/); assert.match(JS, /All their items arrived\?/); assert.match(JS, /"Check in items"/); assert.match(JS, /Check out items \(rented from them\)/); assert.doesNotMatch(JS, /[—–]/);
  assert.match(read('public/ops-board.js'), /pre: \["tcPreList", "tcCheckin", "tcVendors"/); const m = read('public/monitor.html'); assert.ok(m.indexOf('id="monVendors"') > m.indexOf('id="monPreList"') && m.indexOf('id="monVendors"') < m.indexOf('id="monSummary"'));
  assert.match(read('public/day-before.js'), /addEventListener\("helm:vendors"/); assert.match(read('public/vendor-items.css'), /min-height:44px/);
});
test('0448: additive, insert-only, pinned, revoked, listed, read-only check', () => {
  const code = SQL.replace(/--[^\n]*/g, ''); assert.doesNotMatch(code, /\b(update|delete from|truncate|drop)\s+(public|table|function|constraint)/i); assert.match(code, /enable row level security/); assert.match(code, /pg_advisory_xact_lock/); assert.doesNotMatch(SQL, /create temp|set_config/i); assert.ok(/^[\x00-\x7f]*$/.test(SQL));
  assert.equal((code.match(/set search_path = ''/g) || []).length, 9); assert.match(code, /tg_studio_read_only\('org_id'\)/); assert.ok(read('supabase/APPLY-0448.sql').includes(SQL.trimEnd())); assert.ok(read('supabase/migrations/MANIFEST').split('\n').includes('forward  supabase/migrations/0448_r260_vendor_items.sql'));
  assert.match(read('scripts/db-test/run-all.sh'), /R260-VENDOR-ITEMS-0448: ALL PASS \\\(33\/33\\\)/); for (const f of ['test/release-1019.test.mjs', 'test/release-1020.test.mjs']) assert.ok(read(f).includes("'0448'")); assert.match(read('tests/db/trial-retention-0184.sql'), /0448_r260_vendor_items\.sql/); assert.ok(JSON.parse(read('supabase/check-prod-overrides.json'))['0448']);
});
