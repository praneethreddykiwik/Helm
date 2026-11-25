// r252-layout-counts.test.mjs - R252 (owner: "in the 2D/3D we have chairs, type of chairs, number of chairs ... make sure everything
// is working perfectly"). The floor plan's counts end to end, from the REAL builder code (its constants and pure functions are cut out
// of public/builder.js and run in vm) against what the stock calls count (0430 _r430_type_counts, ported here line by line; the SQL
// lines it was ported from are asserted, so a change there fails this file) and what Inventory shows (public/inventory-layout.js).
// Where they differ on purpose or by a known gap, the difference itself is pinned down (KNOWN below) so it cannot move silently.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const rd = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const require = createRequire(import.meta.url);
const L = require('../public/inventory-layout.js');
const B = rd('public/builder.js'), B3 = rd('public/builder-3d.js'), SQL = rd('supabase/migrations/0430_r248_layout_stock.sql');
const CSS = rd('public/inventory-layout.css'), POL = rd('public/inventory-polish.css'), EVCSS = rd('public/event-ui.css'), INV = rd('public/inventory.html'), JS = rd('public/inventory-layout.js');
let n = 0;
const t = (name, fn) => { try { fn(); n++; console.log('  ok ' + name); } catch (e) { console.error('  FAIL ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; } };

/* ---- the builder's own code ---- */
const cut = (from, to) => { const a = B.indexOf(from); assert.ok(a >= 0, 'builder.js: ' + from); const b = B.indexOf(to, a); assert.ok(b > a, 'builder.js: end of ' + from); return B.slice(a, b); };
const src = [
  'const WORLD = { w: 200, h: 140 };',
  cut('const CATS = {', '\n};') + '\n};',
  'const catColor = () => "#000000"; let uid = 1; const nid = () => "obj_" + (uid++);',
  cut('const clamp = (v,a,b)', '\n'), cut('const round1 = v', '\n'),
  cut('const ASSETS = {', '\n};') + '\n};',
  cut('const SEAT_UNIT = {', '\n'), cut('function seatCount(it){', '\n}') + '\n}', cut('const FLOOR_SEATS = {', '\n'), cut('function genSeats(it){', '\n'),
  cut('function makeItem(type, x, y, overrides={}){', '\n}') + '\n}',
  cut('const MAX_ITEMS=3000', '\n'), 'const STAGE_STEPS = [["","centre"],["left","l"]]; const window = undefined;',
  cut('function sanitizeItem(it){', '\n}') + '\n}', cut('function dedupeIds(items){', '\n}') + '\n}',
  cut('const TEMPLATES = {', '\nconst MAX_ITEMS'),
  cut('const VARIANT_STYLES = {', '\n};').replace(/ENTRANCE_STYLES/g, '[]') + '\n};',
  'this.X = { ASSETS, SEAT_UNIT, FLOOR_SEATS, seatCount, genSeats, makeItem, sanitizeItem, dedupeIds, TEMPLATES, VARIANT_STYLES, MAX_BLOCK_SEATS };',
].join('\n');
const ctx = vm.createContext({ console, Math, JSON, Object, Number, Set, Array, String, isFinite, Date });
vm.runInContext(src, ctx);
const X = ctx.X, make = (type, o) => JSON.parse(JSON.stringify(X.makeItem(type, 10, 10, o)));
const save = (items) => JSON.parse(JSON.stringify(X.dedupeIds(items.map((i) => X.sanitizeItem(JSON.parse(JSON.stringify(i)))))));   // what serialize() stores and an opened plan holds

/* ---- 0430, ported: one pass over the items of the latest version ---- */
const num = (v) => typeof v === 'number' ? Math.min(Math.max(v, 0), 100000) : (typeof v === 'string' && /^\s*[0-9]{1,6}(\.[0-9]{1,4})?\s*$/.test(v) ? Math.min(+v, 100000) : null);
function server(items) {
  const by = {};
  items.forEach((e) => {
    const ty = String(e.type == null ? '' : e.type).trim().toLowerCase(); if (!/^[a-z][a-z0-9_]{0,39}$/.test(ty)) return;
    const p = e.properties && typeof e.properties === 'object' ? e.properties : {};
    const r = Math.floor(num(p.rows) || 0), c = Math.floor(num(p.cols) || 0), s = Math.floor(num(p.seats) || 0);
    const seats = r > 0 && c > 0 ? Math.min(r * c, 100000) : s > 0 ? s : (ty === 'chiavari' || ty === 'barstool') ? 1 : 0;
    const m = by[ty] || (by[ty] = { layout_type: ty, objects: 0, seats: 0, labels: {}, category: e.category });
    m.objects++; m.seats += seats; m.labels[e.label] = (m.labels[e.label] || 0) + 1;
  });
  Object.values(by).forEach((m) => { m.label = Object.keys(m.labels).sort((a, b) => m.labels[b] - m.labels[a] || (a < b ? -1 : 1))[0]; });   // mode() within group (order by label)
  return by;
}
const need = (by, links) => { const out = {}; links.forEach((l) => { const tc = by[l.type]; if (tc) out[l.item] = (out[l.item] || 0) + Math.ceil((l.mode === 'seats' ? tc.seats : tc.objects) * (l.per || 1)); }); return out; };

t('the port is the SQL: the lines of 0430 it copies are still there word for word', () => {
  for (const l of ["order by qv.version_no desc, qv.created_at desc limit 1", "lower(btrim(e ->> 'type')) as t", "it.t ~ '^[a-z][a-z0-9_]{0,39}$'",
    "when floor(coalesce(public._r430_num(it.p -> 'seats'), 0)) > 0 then floor(public._r430_num(it.p -> 'seats'))", "when it.t in ('chiavari', 'barstool') then 1 else 0 end as seats",
    "mode() within group (order by s.lbl), count(*)::integer", "ceil((case when l.count_mode = 'seats' then tc.seats else tc.objects end) * l.per_object)"]) assert.ok(SQL.includes(l), l);
  assert.deepEqual({ ...X.SEAT_UNIT }, { chiavari: 1, barstool: 1 });
});
t('every product of the catalogue, placed once as the builder places it: the server counts 1 object and exactly the priced seats', () => {
  let k = 0;
  for (const type of Object.keys(X.ASSETS)) { const it = save([make(type)]), s = server(it)[type];
    assert.equal(s.objects, 1, type); assert.equal(s.seats, X.seatCount(it[0]), type); k++; }
  assert.ok(k > 140, String(k));
});
t('chairs: a table\'s own chairs, rows x cols, single chairs, bar stools, 0 seats, changed seats, a half row', () => {
  const items = save([make('table'), make('table', { properties: { seats: 10 } }), make('table', { properties: { seats: 0 } }), make('longtable'), make('seatblock'), make('seatblock', { properties: { rows: 9, cols: 16 } }),
    make('chairrow', { properties: { rows: 1, cols: 7 } }), make('chiavari'), make('chiavari', { properties: { style: 'ghost' } }), make('barstool'), make('cocktail')]);
  const s = server(items);
  assert.deepEqual([s.table.objects, s.table.seats], [3, 18]); assert.equal(s.longtable.seats, 12);
  assert.deepEqual([s.seatblock.objects, s.seatblock.seats], [2, 140 + 144]); assert.equal(s.chairrow.seats, 7);
  assert.deepEqual([s.chiavari.objects, s.chiavari.seats], [2, 2]); assert.equal(s.barstool.seats, 1); assert.equal(s.cocktail.seats, 3);
  const total = Object.values(s).reduce((a, x) => a + x.seats, 0);
  assert.equal(total, items.reduce((a, i) => a + X.seatCount(i), 0));
  // what the stock page then needs with "1 table per object + 1 chair per seat"
  assert.deepEqual(need(s, [{ type: 'table', item: 'round' }, { type: 'table', item: 'chair', mode: 'seats' }, { type: 'seatblock', item: 'chair', mode: 'seats' }, { type: 'chiavari', item: 'chair' }]),
    { round: 3, chair: 18 + 284 + 2 });
});
t('copies, repeated ids, custom sizes, rotation, colour, stray text numbers: each object counts once', () => {
  const a = make('sofa', { width: 12, height: 4, rotation: 45, color: '#ff0000', colorCustom: true });
  const items = save([a, { ...a }, { ...a, id: 'x' }, make('table', { properties: { seats: '8' } }), make('seatblock', { properties: { rows: '3', cols: '4' } })]);
  const s = server(items); assert.equal(s.sofa.objects, 3); assert.equal(s.table.seats, 8); assert.equal(s.seatblock.seats, 12);
  assert.equal(new Set(items.map((i) => i.id)).size, 5);
});
t('removed = gone: the builder keeps no hidden, deleted or layered items and no groups in the saved plan', () => {
  assert.match(B, /function serialize\(\)\{\s*return \{ items: JSON\.parse\(JSON\.stringify\(store\.items\)\),/);
  assert.doesNotMatch(cut('function makeItem(type', '\n}'), /hidden|layer|groupId|qty|quantity/);
  assert.doesNotMatch(B, /properties\.(hidden|deleted|layer|groupId)\b/);
});
t('3D draws the same chairs from the same numbers (rows x cols, seats), no list of its own', () => {
  assert.match(B3, /for\(const it of store\.items\)\{\s*const g=buildFurniture\(it, chairs\);/);
  assert.equal((B3.match(/const seats=Math\.max\(0,\s*it\.properties\.seats\|0\)/g) || []).length >= 3, true);
  assert.match(B3, /const MAX_CHAIRS_3D=6000;/);   // a drawing cap only: the counts above are never read from the 3D scene
});
t('every built-in layout: objects and priced seats agree with the server, type by type', () => {
  const names = Object.getOwnPropertyNames(X.TEMPLATES).filter((k) => typeof X.TEMPLATES[k] === 'function');
  let seen = 0;
  for (const k of names) { let items; try { items = X.TEMPLATES[k](); } catch (e) { items = null; } if (!Array.isArray(items) || !items.length) continue;
    items = save(items); seen++; const s = server(items);
    assert.equal(Object.values(s).reduce((a, x) => a + x.objects, 0), items.length, k);
    for (const ty of Object.keys(s)) assert.equal(s[ty].seats, items.filter((i) => i.type === ty).reduce((a, i) => a + X.seatCount(i), 0), k + ' ' + ty); }
  assert.ok(seen >= 8, 'templates run: ' + seen);
});

/* ---- KNOWN differences (server side: no SQL in this round; shown truthfully on the page) ---- */
t('KNOWN 1: the planner\'s "seats" also counts sofas and lounges, the server does not - Inventory shows the planner\'s number, and "per seat" is not offered there', () => {
  assert.deepEqual({ ...X.FLOOR_SEATS }, L.FLOOR_SEATS);
  for (const ty of Object.keys(L.FLOOR_SEATS)) { const it = make(ty); assert.equal(server([it])[ty].seats, 0); assert.equal(X.genSeats(it), L.FLOOR_SEATS[ty]);
    assert.equal(L.seatsShown({ layout_type: ty, objects: 2, seats: 0 }), 2 * L.FLOOR_SEATS[ty]); assert.equal(L.linkMode(ty, 0), 'objects'); }
  assert.match(JS, /n\(u\.seats\) > 0 \? h\("option", \{ value: "seats"/);
});
t('KNOWN 2: the chairs drawn on a Dais (8) are counted by nobody (builder, pricing and server agree on 0)', () => {
  const d = make('dais'); assert.equal(d.properties.chairs, 8); assert.equal(X.seatCount(d), 0); assert.equal(X.genSeats(d), 0); assert.equal(server([d]).dais.seats, 0);
});
t('KNOWN 3: the look of a single chair is a property, the server has one number per type - the page splits it from the saved plan', () => {
  const items = save([make('chiavari'), make('chiavari'), make('chiavari', { properties: { style: 'folding' } })]);
  assert.equal(server(items).chiavari.objects, 3); assert.equal(L.styleSplit(items, 'chiavari'), 'Gold chiavari 2, Folding chair 1');
  assert.equal(L.styleSplit(items.slice(0, 2), 'chiavari'), ''); assert.equal(L.styleSplit(items, 'table'), '');
  for (const ty of Object.keys(L.STYLES)) assert.deepEqual(L.STYLES[ty], Object.fromEntries(X.VARIANT_STYLES[ty].map((a) => [...a])), ty);
  for (const ty of ['table', 'seatblock', 'chairrow', 'longtable']) assert.equal(X.VARIANT_STYLES[ty], undefined, ty + ': a table / row has no chair style in the builder');
});
t('KNOWN 4: line pieces (fence, barricade, drape) count as 1 whatever their length', () => {
  assert.equal(server(save([make('fence', { width: 222, height: 1 })])).fence.objects, 1);
});
t('KNOWN 5: an item with a spec quantity (8 par lights) is 1 object on the server', () => {
  assert.equal(server(save([make('lighting', { properties: { spec: { kind: 'par', qty: 8, lengthM: 10 } } })])).lighting.objects, 1);
});
t('fixed: the name shown is the catalogue name, never a label typed on the plan ("Section A", "LED Screen L")', () => {
  for (const [k, a] of Object.entries(X.ASSETS)) assert.equal(L.LABELS[k], a.label, k);
  assert.equal(Object.keys(L.LABELS).length, Object.keys(X.ASSETS).length);
  const s = server(save([make('seatblock', { label: 'Section A' }), make('seatblock', { label: 'Section B' }), make('ledscreen', { label: 'LED Screen L' })]));
  assert.equal(s.seatblock.label, 'Section A'); assert.equal(L.typeLabel('seatblock', s.seatblock.label), 'Seating Block'); assert.equal(L.countText(s.ledscreen), 'LED Screen x 1');
});

/* ---- the page ---- */
t('countText: type and count, seats where it seats people', () => {
  assert.equal(L.countText({ layout_type: 'table', objects: 10, seats: 80 }), 'Round Table x 10 (80 seats)');
  assert.equal(L.countText({ layout_type: 'chiavari', objects: 120, seats: 120 }), 'Chair (single) x 120');
  assert.equal(L.countText({ layout_type: 'sofa', objects: 2, seats: 0 }), 'Sofa x 2 (6 seats)'); assert.equal(L.countText({ layout_type: 'exit', objects: 1 }), 'Exit Zone x 1');
});
t('the chairs around a table are their own line until they are linked per seat', () => {
  const tb = (links) => ({ types: [{ layout_type: 'table', objects: 10, seats: 80, links }, { layout_type: 'sofa', objects: 2, seats: 0, links: [] }] });
  assert.deepEqual(L.seatGaps(tb([])).map((g) => [g.label, g.seats]), [['Chairs for Round Table', 80]]);
  assert.equal(L.seatGaps(tb([{ count_mode: 'objects' }])).length, 1); assert.equal(L.seatGaps(tb([{ count_mode: 'objects' }, { count_mode: 'seats' }])).length, 0);
  assert.deepEqual(L.thingOf({ layout_type: 'seatblock', objects: 4, seats: 560 }), { label: 'Chairs for Seating Block', qty: 560, mode: 'seats' });
  assert.deepEqual(L.thingOf({ layout_type: 'ledscreen', objects: 2, seats: 0 }), { label: 'LED Screen', qty: 2, mode: 'objects' });
});
t('suggestions: the one item that fits by name, per seat only for rows of chairs; nothing when several fit; never an already linked one', () => {
  const I = (id, name) => ({ id, name, active: true }), items = [I('c', 'Chiavari chair'), I('r', 'Round table 5ft'), I('q', 'Rectangular table 6ft'), I('l', 'LED screen 20x10'), I('b', 'Barricade 2 m'), I('u', 'Uplight (LED)')];
  const s = (type, seats, links, part, list) => L.suggestLink({ layout_type: type, seats }, list || items, links || [], part);
  assert.deepEqual([s('table', 80).item_id, s('table', 80).mode], ['r', 'objects']); assert.equal(s('recttable', 9).item_id, 'q');
  assert.equal(s('ledscreen').item_id, 'l'); assert.equal(s('barricade').item_id, 'b'); assert.equal(s('uplight').item_id, 'u');
  assert.deepEqual([s('seatblock', 560).item_id, s('seatblock', 560).mode], ['c', 'seats']); assert.deepEqual([s('table', 80, [], 'seats').item_id, s('table', 80, [], 'seats').mode], ['c', 'seats']);
  assert.deepEqual([s('chiavari', 5).item_id, s('chiavari', 5).mode], ['c', 'objects']);
  const two = items.concat(I('f', 'Folding chair')); assert.equal(s('seatblock', 9, [], null, two), null); assert.equal(s('chiavari', 9, [], null, two).item_id, 'c');
  assert.equal(s('seatblock', 9, [{ layout_type: 'table', item_id: 'f', count_mode: 'seats' }], null, two).item_id, 'f');   // the chair the studio already counts per seat
  assert.equal(s('ledscreen', 0, [{ layout_type: 'ledscreen', item_id: 'l' }]), null); assert.equal(s('exit', 0, [], null, [I('e', 'Exit zone')]), null);
  assert.equal(s('sofa', 0), null); assert.equal(s('ledscreen', 0, [], null, [{ ...items[3], active: false }]), null);
  assert.match(JS, /BPUI\.confirm\("Count " \+ optName\(sug\.name\)/);   // a suggestion only: it asks before it links
});
t('given out, vendors on the missing part: only what is agreed or asked is taken off, an unread vendor row never is', () => {
  assert.equal(L.outQty([{ item_id: 'c', quote_id: 'q', qty_out: 30, qty_in: 10, status: 'partial' }, { item_id: 'c', quote_id: 'x', qty_out: 9, status: 'out' }, { item_id: 'c', quote_id: 'q', qty_out: 5, status: 'cancelled' }], 'c', 'q'), 20);
  assert.deepEqual(L.coverOf(30, [{ status: 'enquiry', qty: 10 }, { status: 'booked', qty: 5 }]), { agreed: 5, asked: 10, left: 15 });
  assert.deepEqual(L.coverOf(30, [{ status: 'enquiry', qty: 30, cover: false }]), { agreed: 0, asked: 0, left: 30 });
  assert.deepEqual(L.coverOf(10, [{ status: 'confirmed', qty: 25 }]), { agreed: 10, asked: 0, left: 0 });
});
t('reserve of one line: never more than is free, nothing recorded as short', () => {
  const b = { items: [{ item_id: 'c', name: 'Chair', needed: 120, held: 50, free: 40, to_reserve: 70, to_borrow: 30 }, { item_id: 'd', needed: 5, held: 0, free: 5, to_reserve: 5, to_borrow: 0 }] };
  assert.deepEqual(L.reservePlan(b, { itemId: 'c', freeOnly: true }).lines.map((l) => [l.item_id, l.qty, l.short]), [['c', 40, 0]]);
  assert.deepEqual(L.reservePlan(b).lines.map((l) => [l.qty, l.short]), [[70, 30], [5, 0]]);
});
t('the page: no HTML strings, no inline styles, no money; the new files are loaded; the vendor dialog is asked for, never a second flow', () => {
  assert.doesNotMatch(JS, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\.style\.|setAttribute\(\s*["']style/);
  assert.doesNotMatch(JS, /studioMoney|unit_cost|\.cost\b/); assert.match(JS, /root\.HelmStockVendor\.open\(/); assert.doesNotMatch(JS, /bookings\.add|addNeed\(/);
  assert.match(INV, /<script src="\/stock-vendor\.js\?v=\d+"><\/script>\s*<script src="inventory-layout\.js/); assert.match(INV, /href="\/stock-vendor\.css\?v=\d+"/);
  for (const w of ['Given out', 'Missing', 'Get from a vendor', 'Link to ', 'Not linked to stock yet']) assert.ok(JS.includes(w), w);
});
t('spacing: one gap on the event page, the inventory tabs / toolbar / cards; balanced CSS', () => {
  assert.match(EVCSS, /#app > :is\(\.card,\.grid,\.moretog,\.mh-wrap,section\)\{margin-top:0;margin-bottom:var\(--ev-gap\)\}/);
  assert.match(POL, /#app > \.tabs\{display:flex/); assert.match(POL, /#eventPanel > \.ls-panel,#eventPanel > \.sc-card\{margin:24px 0 0/);
  for (const c of [CSS, POL, EVCSS]) assert.equal((c.match(/\{/g) || []).length, (c.match(/\}/g) || []).length);
});
console.log('\nr252-layout-counts: ' + n + ' passed');
