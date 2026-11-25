// r248-inventory-layout.test.mjs - R248: the products of the 2D / 3D floor plan on the Inventory page, no database:
//  * the client math (public/inventory-layout.js, pure part run in Node): numbers per item line, category groups, the
//    "Reserve from layout" plan (from stock now / short), "Same day as ..." wording, unlinked products across events,
//    the top strip (items, units, out now, events short), date steps;
//  * 0430 + APPLY-0430 are additive, ASCII, paste-safe (begin + lock_timeout + statement_timeout, the migration verbatim,
//    check rows, commit, no temp tables), the writes go through the calls only, the marker is recorded;
//  * the page: the From layouts tab, the per-event table, the strip, the plain-words same-day note, the new files loaded,
//    no HTML strings / inline styles in the new script, store-api calls the 5 functions; release lists know 0430.
// The database side: tests/db/r248-layout-stock-0430.sql.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const rd = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const require = createRequire(import.meta.url);
const L = require('../public/inventory-layout.js');
const MIG = rd('supabase/migrations/0430_r248_layout_stock.sql'), APPLY = rd('supabase/APPLY-0430.sql');
const MF = rd('supabase/migrations/MANIFEST'), RA = rd('scripts/db-test/run-all.sh'), PK = JSON.parse(rd('package.json'));
const SA = rd('public/store-api.js'), INV = rd('public/inventory.html'), JS = rd('public/inventory-layout.js'), CSS = rd('public/inventory-layout.css');
const PT = rd('public/page-tours.js');
let n = 0;
const t = (name, fn) => { try { fn(); n++; console.log('  ok ' + name); } catch (e) { console.error('  FAIL ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; } };
const code = (s) => s.replace(/^\s*--.*$/gm, '');

// one block the way layout_stock_needs answers it (the wedding of the DB suite)
const BLOCK = {
  quote_id: 'q1', title: 'Reddy Wedding', from: '2026-12-13', to: '2026-12-13', objects: 12, short_items: 2, shared_items: 1,
  types: [
    { layout_type: 'table', category: 'seating', label: 'Round Table', objects: 4, seats: 22 },
    { layout_type: 'seatblock', category: 'seating', label: 'Seating Block', objects: 1, seats: 140 },
    { layout_type: 'barricade', category: 'security', label: 'Barricade', objects: 4, seats: 0 },
    { layout_type: 'exit', category: 'safety', label: 'Exit Zone', objects: 1, seats: 0 },
  ],
  items: [
    { item_id: 'i2', name: 'Chiavari chair', unit: 'pcs', types: ['table', 'seatblock'], needed: 162, held: 50, free: 100, to_reserve: 112, to_borrow: 12, to_borrow_shared: 12, same_day: [] },
    { item_id: 'i1', name: 'Round table 6 ft', unit: 'pcs', types: ['table'], needed: 4, held: 4, free: 6, to_reserve: 0, to_borrow: 0, to_borrow_shared: 0, same_day: [] },
    { item_id: 'i3', name: 'Barricade 2 m', unit: '', types: ['barricade'], needed: 4, held: 0, free: 6, to_reserve: 4, to_borrow: 0, to_borrow_shared: 2,
      same_day: [{ quote_id: 'q2', event: 'Rao Rally', needs: 4, holds: 0 }] },
    { item_id: 'i4', name: 'Old podium', active: false, types: ['barricade'], needed: 3, held: 0, free: 0, to_reserve: 3, to_borrow: 3 },
  ],
  unlinked: [{ layout_type: 'exit', category: 'safety', label: 'Exit Zone', objects: 1, seats: 0 }],
};

t('rowNums: needed / held / free / to borrow, short + shared short, covered; derived when the server leaves a number out', () => {
  assert.deepEqual(L.rowNums(BLOCK.items[0]), { needed: 162, held: 50, free: 100, toReserve: 112, toBorrow: 12, toBorrowShared: 12, short: true, sharedShort: false, covered: false });
  const b = L.rowNums(BLOCK.items[2]); assert.equal(b.short, false); assert.equal(b.sharedShort, true); assert.equal(b.toBorrowShared, 2);
  assert.equal(L.rowNums(BLOCK.items[1]).covered, true);
  assert.deepEqual(L.rowNums({ needed: 10, held: 3, free: 4 }), { needed: 10, held: 3, free: 4, toReserve: 7, toBorrow: 3, toBorrowShared: 3, short: true, sharedShort: false, covered: false });
  assert.equal(L.rowNums({ needed: -5, held: 'x', free: null }).needed, 0);
});
t('groupItems: by the floor-plan category of the first layout product, Seating first, names sorted, "From" labels', () => {
  const g = L.groupItems(BLOCK);
  assert.deepEqual(g.map((x) => x.name), ['Seating', 'Security']);
  assert.deepEqual(g[0].items.map((x) => x.name), ['Chiavari chair', 'Round table 6 ft']);
  assert.deepEqual(g[0].items[0].from, ['Seating Block', 'Round Table']);   // types sorted: seatblock, table
  assert.deepEqual(L.groupItems({ items: [{ item_id: 'x', name: 'Odd', types: ['zz'] }] }).map((x) => x.name), ['Other']);
  assert.deepEqual(L.groupItems(null), []);
});
t('reservePlan: only active items with something left to reserve; from stock now = min(to reserve, free), the rest short', () => {
  const p = L.reservePlan(BLOCK);
  assert.deepEqual(p.lines.map((l) => [l.item_id, l.qty, l.fromStock, l.short]), [['i2', 112, 100, 12], ['i3', 4, 4, 0]]);
  assert.equal(p.qty, 116); assert.equal(p.fromStock, 104); assert.equal(p.short, 12);
  assert.equal(L.reservePlan({ items: [{ item_id: 'a', needed: 2, held: 2, free: 9 }] }).lines.length, 0);
  assert.deepEqual(L.reservePlan({ items: [{ item_id: 'a', needed: 5, held: 0, free: 2.7 }] }).lines[0], { item_id: 'a', name: 'Item', unit: '', qty: 5, fromStock: 2, short: 3 });
});
t('sameDayText: one / two / more events, duplicates once', () => {
  assert.equal(L.sameDayText([]), '');
  assert.equal(L.sameDayText([{ event: 'Rao Rally' }]), 'Same day as Rao Rally');
  assert.equal(L.sameDayText([{ event: 'A' }, { event: 'A' }, { event: 'B' }]), 'Same day as A and B');
  assert.equal(L.sameDayText([{ event: 'A' }, { event: 'B' }, { event: 'C' }]), 'Same day as A + 2 more');
});
t('unlinkedAll: one line per product across events (objects + seats added, events counted), hidden ones left out', () => {
  const ov = { events: [BLOCK, { unlinked: [{ layout_type: 'exit', label: 'Exit Zone', category: 'safety', objects: 2 }, { layout_type: 'bar', label: 'Bar', category: 'logistics', objects: 1 }] }] };
  const u = L.unlinkedAll(ov);
  assert.deepEqual(u.map((x) => [x.layout_type, x.objects, x.events]), [['bar', 1, 1], ['exit', 3, 2]]);   // logistics before safety
  assert.deepEqual(L.unlinkedAll(ov, { exit: 1 }).map((x) => x.layout_type), ['bar']);
  assert.deepEqual(L.unlinkedAll(null), []);
});
t('strip: active items, units owned, out now (not back of open check-outs), events short from the overview', () => {
  const s = L.strip([{ total_qty: 10 }, { total_qty: 5, active: false }, { total_qty: 3 }],
    [{ status: 'out', qty_out: 8, qty_in: 2 }, { status: 'returned', qty_out: 5 }, { status: 'partial', qty_out: 4, qty_in: 1, written_off: 1, qty_damaged: 1 }],
    { summary: { events_short: 2 } });
  assert.deepEqual(s, { items: 2, units: 13, outNow: 9, eventsShort: 2 });
  assert.equal(L.strip([], [], null).eventsShort, null);
});
t('addDays + shortOnly + typeLabel + catName', () => {
  assert.equal(L.addDays('2026-12-30', 3), '2027-01-02'); assert.equal(L.addDays('2026-02-28', 1), '2026-03-01'); assert.equal(L.addDays('bad', 1), null);
  assert.deepEqual(L.shortOnly([{ short_items: 0 }, { short_items: 1 }, { shared_items: 2 }]).length, 2);
  assert.equal(L.typeLabel('table', 'Section A'), 'Round Table'); assert.equal(L.typeLabel('mything', ''), 'Mything');   // R252: the catalogue name, not a label typed on the plan
  assert.equal(L.typeLabel('x', 'Round Table'), 'Round Table');
  assert.equal(L.catName('av'), 'AV & Stage'); assert.equal(L.catName(''), 'Other');
  assert.deepEqual(L.RANGES, [7, 14, 30, 60, 90]);
});

t('0430: additive only - no drop table / column, no truncate, no row delete; ASCII; marker; definer + empty search_path', () => {
  const c = code(MIG);
  assert.doesNotMatch(c, /\bdrop\s+(table|column|schema|function)\b/i);
  assert.doesNotMatch(c, /\btruncate\b/i);
  assert.doesNotMatch(c, /\bdelete\s+from\b/i);
  assert.ok(/^[\x00-\x7f]*$/.test(MIG), 'ASCII');
  assert.match(c, /insert into public\.helm_schema_markers\(num, name\) values \(430, '0430_r248_layout_stock'\)/);
  const defs = [...c.matchAll(/create or replace function (public\.[a-z0-9_]+)\(/g)].map((m) => m[1]);
  assert.equal(defs.length, 12, defs.join(' '));
  for (const m of c.matchAll(/create or replace function public\.([a-z0-9_]+)\([^]*?as \$fn\$/g)) assert.match(m[0], /set search_path = ''/, m[1]);
  // writes only through the calls: the table is select-only for signed-in staff, no insert / update / delete grant
  assert.match(c, /grant select on table public\.inventory_layout_links to authenticated/);
  assert.doesNotMatch(c, /grant (insert|update|delete|all)[^;]*inventory_layout_links/i);
  // removing a link keeps the row
  assert.match(c, /update public\.inventory_layout_links set removed_at = now\(\), removed_by = auth\.uid\(\)/);
  // it never reserves, never touches a reservation, never creates a stock item
  assert.doesNotMatch(c, /insert into public\.inventory_(reservations|items)|update public\.inventory_(reservations|items)/);
  // the per-day stock rule is the 0374 one, not a copy
  assert.match(c, /public\._r374_load\(base\.item_id, p_quote, p_org\)/);
});
t('APPLY-0430: begin, lock_timeout 5s, statement_timeout, the migration verbatim, check rows, commit, no temp tables', () => {
  assert.ok(/^[\x00-\x7f]*$/.test(APPLY), 'ASCII');
  assert.match(APPLY, /\nbegin;\nset local lock_timeout = '5s';\nset local statement_timeout = '5min';\n/);
  assert.ok(APPLY.includes(MIG.trimEnd()), 'verbatim');
  assert.match(APPLY, /select item, ok from \(values/);
  assert.equal((APPLY.match(/^  \('0\d /gm) || []).length, 7);
  assert.match(APPLY, /\ncommit;\n?$/);
  assert.doesNotMatch(code(APPLY), /create temp|temporary table|set session/i);
});
t('release lists: MANIFEST after 0429, the DB suite + APPLY twice in run-all, this test in npm test', () => {
  assert.ok(MF.indexOf('forward  supabase/migrations/0430_r248_layout_stock.sql') > MF.indexOf('forward  supabase/migrations/0429_r247_storage_usage.sql'));
  assert.match(RA, /run "r248-layout-stock-0430" "R248-LAYOUT-STOCK-0430: ALL PASS \\\(\d+\/\d+\\\)" psql -q -f tests\/db\/r248-layout-stock-0430\.sql/);
  assert.match(RA, /run "r248-apply-0430" "APPLY-0430: ALL OK"/);
  assert.match(PK.scripts.test, /node test\/r248-inventory-layout\.test\.mjs/);
});
t('store-api: inventory.layout calls the 5 functions, null on a database without 0430 (feature hidden)', () => {
  const i = SA.indexOf('    layout: {'), blk = SA.slice(i, SA.indexOf('\n    },', i));
  for (const f of ['layout_stock_needs', 'layout_stock_overview', 'layout_links', 'layout_link_set', 'layout_link_remove']) assert.match(blk, new RegExp('"' + f + '"'), f);
  assert.match(blk, /if \(rpcMissing\(e\)\) return null/);
  assert.match(blk, /p_count_mode: countMode === "seats" \? "seats" : "objects"/);
});
t('page: tab + pane + per-event table + strip + the plain-words same-day note; new files loaded and bumped', () => {
  assert.match(INV, /aria-controls="pane-layout" id="tabLayout"/);
  assert.match(INV, /<div id="pane-layout" hidden>/);
  assert.match(INV, /<div id="layoutNeeds" class="ls-panel" hidden><\/div>/);
  assert.match(INV, /id="invSummary"/);
  for (const id of ['isItems', 'isUnits', 'isOut', 'isShort', 'lsRange', 'lsShortOnly', 'lsEvents', 'lsLinks', 'lsLinkBody', 'lsLinked']) assert.match(INV, new RegExp('id="' + id + '"'), id);
  assert.ok(INV.includes("Helm counts stock by day. Two events on the same day can't share the same units unless they come back - reserve separately or set a later stock date."));
  assert.match(INV, /<script src="inventory-layout\.js\?v=\d+"><\/script>/);
  assert.match(INV, /<link rel="stylesheet" href="inventory-layout\.css\?v=\d+">/);
  assert.match(INV, /\$\("#pane-layout"\)\.hidden=pane!=="layout"/);
  assert.match(INV, /HelmLayoutStock\.mount\(\{ quoteId:quoteId\|\|null, canEdit,/);
  assert.match(INV, /tp==="layout"\|\|tp==="layouts"/);
  for (const w of ['In layout', 'Reserved', 'Free that day', 'Given out', 'Missing', 'Reserve from layout', 'Create stock item', 'Same day as ']) assert.ok(JS.includes(w), w);
});
t('new script: DOM nodes only (no innerHTML / insertAdjacentHTML / document.write), no inline styles; CSS has a phone layout', () => {
  assert.doesNotMatch(JS, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.doesNotMatch(JS, /\.style\.|setAttribute\(\s*["']style/);
  assert.doesNotMatch(JS, /"style"\s*:/);
  assert.match(CSS, /@media \(max-width:640px\)/);
  assert.match(JS, /try \{ var v = JSON\.parse\(root\.localStorage\.getItem\(HIDE_KEY\)/);   // a blocked storage never breaks the page
});
t('tour: the floor-plan table and the From layouts tab are explained', () => {
  assert.match(PT, /sel: "#layoutNeeds", title: "From the floor plan"/);
  assert.match(PT, /sel: \["#pane-layout", '\[aria-controls="pane-layout"\]'\], title: "From layouts"/);
});

t('speed (owner): the boot starts every read side by side - no await waterfall; the stock list = 1 round trip', () => {
  const b = INV.slice(INV.indexOf('  BPUI.boot(async ()=>{'), INV.indexOf('</script>', INV.indexOf('  BPUI.boot(async ()=>{')));
  assert.match(b, /await Promise\.all\(jobs\)/);
  for (const w of [/await BPStore\.smartImport/, /await fillPeople/, /await BPStore\.inventory\.stock\.settings/, /await BPStore\.quotes\.get/, /await renderAccount/, /await HelmLayoutStock/])
    assert.doesNotMatch(b, w, String(w));
  assert.ok(b.indexOf('$("#app").hidden=false') < b.indexOf('const jobs=['), 'the page (skeleton) shows before the reads');
  const l = INV.slice(INV.indexOf('  async function load(){'), INV.indexOf('  function applyLoans('));
  assert.match(l, /BPStore\.inventory\.availability\(quoteId\|\|undefined, undefined, itemsP\)/);   // items read once
  assert.match(l, /wantLoans && !quoteId \? BPStore\.quotes\.list\(\)/);   // every event row only for the Out & back lists
  assert.match(l, /wantLoans \? BPStore\.inventory\.checkouts\.list/);
  assert.match(INV, /if\(pane==="loans"\) loadLoans\(\);/);
  // store-api: one call for the demand, the old row reads only on a database without 0430
  const d = SA.slice(SA.indexOf('    async _demand('), SA.indexOf('    async availability(quoteId, itemIds, preItems)'));
  assert.match(d, /rpc\("inventory_demand", \{ p_quote:/);
  assert.match(d, /if \(rpcMissing\(e\)\) \{ demandRpc = false; return null; \}/);
  assert.ok(d.indexOf('rpc("inventory_demand"') < d.indexOf('this.reservations(null'), 'rows only as the fallback');
});
t('loading state: a skeleton in the page shape (strip, tabs, toolbar, table rows) - no lone spinner, no empty #boot', () => {
  assert.doesNotMatch(INV, /<div id="boot" aria-busy="true"><\/div>/);
  assert.match(INV, /<div id="boot" class="inv-skel"[^>]*>[\s\S]*?class="ls-strip"[\s\S]*?sk-tabs[\s\S]*?sk-bar[\s\S]*?sk-row/);
  for (const id of ['stockRows', 'loanRows', 'lossRows', 'resRows']) {
    const m = new RegExp('<tbody id="' + id + '" aria-busy="true">(.*?)</tbody>').exec(INV);
    assert.ok(m && /sk-row/.test(m[1]) && !/bpui-spin2/.test(m[1]), id);
  }
  assert.match(INV, /<div id="invSummary" class="ls-strip" role="group" aria-label="Stock at a glance">/);   // visible from the start (no jump)
  assert.match(INV, /<span class="ls-tv" id="isItems"><span class="sk sk-num"><\/span><\/span>/);
  assert.match(CSS, /#boot\.inv-skel\{display:block/);
  assert.match(CSS, /@media \(prefers-reduced-motion:reduce\)\{\.sk\{animation:none\}\}/);
  assert.match(JS, /if \(!S\.o\.ready \|\| S\.o\.ready\(\)\)/);   // no 0 flashing before the stock is in
  assert.match(JS, /function skeletonCard\(\)/);
});

console.log(`\nr248-inventory-layout: ${n} passed`);
