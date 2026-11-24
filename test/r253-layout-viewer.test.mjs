// R253: the read-only layout viewer (owner 25 Nov 2026: "when Layout is clicked it opens like a dropdown with only these options,
// no headers, nothing; only the map with pinch zoom; and in measure they want the distances very clearly").
//   1 one drawing: floor-draw.js / floor-3d.js are generated from the planner's own files, fresh, and change nothing in the planner
//   2 the plan: cleaned and drawn exactly like the planner (colours, sizes, rotation, margins, unit), no keyboard stops, no edit hints
//   3 measure (pure): ft-in and metres, snapping, shape-to-shape gaps, 4 walls + nearest neighbours, key distances, labels never overlap
//   4 the card + the viewer: one Layout button with 4 choices, plan only, lazy 3D, no write / no photo render / no inline style, themes, 44 px
// Pixel + 3D-scene comparisons against the real planner run in a browser (scratch harness, see the R253 report); here the same source is proven.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { floorDraw, floor3d } from '../scripts/gen-floor-view.mjs';
import { COVERAGE, LAYOUTS } from './fixtures/walk-layouts.mjs';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack)); } };
const FD = read('public/floor-draw.js'), F3 = read('public/floor-3d.js'), FV = read('public/floor-view.js'), CSS = read('public/floor-view.css'), EF = read('public/event-floor.js'), EFCSS = read('public/event-floor.css');
const BJS = read('public/builder.js'), BCSS = read('public/builder.css'), B3 = read('public/builder-3d.js');

// ---- a tiny DOM ----
function mk(tag) {
  const n = { tagName: tag, attrs: {}, children: [], style: { setProperty(k, v) { this[k] = v; } }, textContent: '',
    setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }, removeAttribute(k) { delete this.attrs[k]; },
    appendChild(c) { this.children.push(c); return c; }, get firstChild() { return this.children[0] || null; },
    querySelectorAll(q) { const out = []; const hit = (c) => q === '*' || (q[0] === '.' ? String(c.attrs.class || '').split(' ').includes(q.slice(1)) : c.tagName === q); const w = (x) => x.children.forEach((c) => { if (hit(c)) out.push(c); w(c); }); w(this); return out; } };
  return n;
}
const doc = { createElementNS: (ns, tag) => mk(tag), querySelector: () => null };
const req = createRequire(import.meta.url);
function loadDraw() {
  const W = { document: doc }; const box = { window: W, document: doc, console, JSON, Math, Object, Array, Number, String, isFinite, Set, Map, Date, RegExp, Error };
  W.HelmScreen = box.HelmScreen = req('../public/stage-screen.js'); W.HelmBuilderTools = box.HelmBuilderTools = req('../public/builder-tools.js');
  vm.runInNewContext(FD, box); return W.HelmFloorDraw;
}
const D = loadDraw(), V = req('../public/floor-view.js');
const plan = (o) => D.prepare(Object.assign({ world: { w: 120, h: 80 }, unit: 'ft', margins: {}, items: [] }, o));
const IT = (type, x, y, width, height, o) => Object.assign({ id: type + x + '_' + y, type, category: 'structure', label: type, x, y, width, height, rotation: 0, properties: {} }, o);
const near = (a, b, e = 0.011) => assert.ok(Math.abs(a - b) <= e, a + ' ~ ' + b);

await t('1a floor-draw.js and floor-3d.js are fresh (node scripts/gen-floor-view.mjs)', () => {
  assert.ok(FD === floorDraw(), 'floor-draw.js is stale'); assert.ok(F3 === floor3d(), 'floor-3d.js is stale');
});
await t('1b the planner\'s drawing is inside word for word; the planner itself does not know the viewer', () => {
  const fnSrc = (s, n) => { const i = s.indexOf('function ' + n + '('); const j = s.indexOf('\n}', i); return s.slice(i, j + 2); };
  for (const n of ['renderItem', 'renderMargins', 'screenBand2D', 'screenFace2D', 'sanitizeItem', 'clampItem', 'sanitizeMargins']) assert.ok(fnSrc(BJS, n).length > 100 && FD.includes(fnSrc(BJS, n)), n);
  assert.ok(FD.includes(BJS.slice(BJS.indexOf('  // --- grid ---\n'), BJS.indexOf('  // --- items ---'))), 'grid + floor border');
  assert.ok(!/floor-view|HelmFloorView|HelmFloorDraw|HelmFloor3D|floor-draw|floor-3d/.test(BJS + B3), 'builder.js / builder-3d.js untouched by the viewer');
  // 3D: every line of builder-3d.js is there except the named hand-overs
  const out = new Set(F3.split('\n')); const missing = B3.split('\n').filter((l) => !out.has(l) && !/window\.addEventListener\(|bps\.labels3d|getElementById\('(scene3d|stage3d|viewSeg|legend3d)'\)|querySelector\('\.viewport'\)|window\.__|window\.HelmWizard/.test(l));
  assert.deepEqual(missing, []);
});
await t('1c the 3D copy can not edit, save or leave hooks on the page; no photo render', () => {
  const body = F3.slice(F3.indexOf('/* ======== from builder-3d.js'));
  assert.ok(!/window\.__|window\.addEventListener\(|localStorage\.setItem|document\.getElementById\(/.test(body));
  assert.match(F3, /RO = true/); assert.match(F3, /commit = H\.noop, renderAll = H\.noop/);
  assert.ok(!/photo-render|renderPhoto|BPStore|fetch\(|XMLHttpRequest|\.rpc\(/.test(F3 + FD), 'no data call, no photo render');
  const W = { document: doc }; vm.runInNewContext(F3, { window: W, document: doc }); const A = W.HelmFloor3D.allowsGroup;
  const L = req('../public/layout-wizard.js'); const HW = L.allowsGroup ? L : globalThis.HelmWizard;
  for (const ev of ['', 'Wedding', 'Political rally', 'conference', 'Birthday party', 'concert', 'iftar', 'junk']) assert.equal(A(ev, 'floral'), HW ? HW.allowsGroup(ev, 'floral') : A(ev, 'floral'), ev);
  assert.equal(A('political', 'floral'), false); assert.equal(A('wedding', 'floral'), true);
});
await t('1d the colours are the planner\'s (builder.css)', () => {
  const root = BCSS.slice(0, BCSS.indexOf('}'));
  for (const [k, v] of Object.entries(D.PALETTE)) assert.ok(root.includes(k + ':' + v + ';'), k);
  for (const [k, v] of Object.entries(D.CAT)) assert.ok(root.includes('--c-' + k + ':' + v + ';'), k);
});

await t('2a cleaned like the planner opens it: hall size, clamped items, bad numbers, colours, ids', () => {
  const p = plan({ world: { w: 119.6, h: 5000 }, margins: { left: 3, right: -2, top: 'x' }, unit: 'm', items: [IT('stage', -5, 2, 4000, 16, { color: '#2F6FED' }), IT('table', 'a', 1, 6, 6, { category: 'nope', color: '#8e24aa', id: 'q' }), IT('dj', 1, 1, 8, 5, { id: 'q', color: 'red' }), null, 'x'] });
  assert.deepEqual(JSON.parse(JSON.stringify(p.world)), { w: 120, h: 1000 }); assert.equal(p.unit, 'm'); assert.equal(p.items.length, 3);
  assert.equal(p.items[0].width, 120); assert.equal(p.items[0].x, 0); assert.equal(p.items[1].x, 0);
  assert.equal(p.items[0].color, D.CAT.structure); assert.equal(p.items[1].color, '#8e24aa', 'a chosen colour stays'); assert.equal(p.items[2].color, D.CAT.structure);
  assert.notEqual(p.items[1].id, p.items[2].id); assert.equal(p.margins.left, 3); assert.equal(p.margins.right, 0);
  const full = D.prepare({ scale: { worldFt: { w: 100, h: 60 } }, grid: { unit: 'm' }, items: [IT('dj', 1, 1, 8, 5, { color: '#123456', colorCustom: false, category: 'av' }), IT('dj', 20, 1, 8, 5, { color: '#123456', colorCustom: true, category: 'av' })] });
  assert.equal(full.unit, 'm'); assert.equal(full.world.w, 100); assert.equal(full.items[0].color, D.CAT.av); assert.equal(full.items[1].color, '#123456');
  assert.equal(D.prepare({ items: [], hall: { len: 90, wid: 50 } }).world.w, 90); assert.equal(D.prepare(null).world.w, 200, 'nothing saved = the planner\'s default hall');
});
await t('2b drawn with the planner\'s shapes: every catalogue item type, real layouts, turned items, 12 px per foot', () => {
  const types = [...BJS.slice(BJS.indexOf('const ASSETS = {'), BJS.indexOf('\n};', BJS.indexOf('const ASSETS = {'))).matchAll(/^ {2}([a-z0-9]+): *\{ label/gim)].map((m) => m[1]);
  assert.ok(types.length > 100, types.length + ' types');
  const sv = D.svg(plan({ world: { w: 300, h: 300 }, items: types.map((x, i) => IT(x, (i % 14) * 20, Math.floor(i / 14) * 20, 12, 10, { rotation: i * 30, properties: { rows: 3, cols: 4, seats: 6 } })) }));
  const objs = sv.querySelectorAll('.obj'); assert.equal(objs.length, types.length); assert.equal(sv.attrs.viewBox, '0 0 3600 3600');
  objs.forEach((o) => { assert.equal(o.attrs.tabindex, undefined); assert.equal(o.attrs.role, undefined); assert.equal(o.attrs['aria-hidden'], 'true'); assert.ok(!JSON.stringify(o.attrs).includes('NaN')); });
  assert.ok(!/NaN|undefined/.test(JSON.stringify(sv)), 'no broken numbers');
  for (const [n, items, hall] of COVERAGE.concat(LAYOUTS.map((l) => [l.name, l.items, l.hall]))) assert.equal(D.svg(plan({ world: hall, items })).querySelectorAll('.obj').length, items.length, n);
  assert.equal(sv.querySelectorAll('.scr-ph').length, 0, 'no "Tap to add" hint');
});

await t('3a lengths: feet + inches and metres, the studio\'s unit first', () => {
  assert.equal(V.ftIn(12.5), '12 ft 6 in'); assert.equal(V.ftIn(0.5), '6 in'); assert.equal(V.ftIn(4), '4 ft'); assert.equal(V.ftIn(0), '0 ft'); assert.equal(V.ftIn(5.999), '6 ft'); assert.equal(V.ftIn(NaN), '');
  assert.equal(V.metres(10), '3.05 m'); assert.deepEqual(V.dist(10, 'm'), { main: '3.05 m', alt: '10 ft' }); assert.deepEqual(V.dist(10, 'ft'), { main: '10 ft', alt: '3.05 m' });
});
const W80 = { w: 120, h: 80 };
await t('3b snapping: corner, side middle, centre, edge, wall, hall corner, bare floor, outside the hall', () => {
  const gs = [V.geo(IT('stage', 40, 10, 40, 16, { label: 'Stage' })), V.geo(IT('table', 10, 50, 6, 6, { label: 'T1', properties: { seats: 8 } }))];
  const S = (x, y, tol = 1) => V.snap({ x, y }, gs, W80, tol);
  assert.deepEqual([S(40.4, 10.3).kind, S(40.4, 10.3).x, S(40.4, 10.3).y], ['corner', 40, 10]);
  assert.equal(S(60.3, 26.2).kind, 'middle of the side'); assert.equal(S(60, 18.2).kind, 'centre');
  const e = S(50, 26.4); assert.equal(e.kind, 'edge'); near(e.y, 26); near(e.x, 50);
  const r = S(16.4, 53.0); assert.equal(r.name, 'T1'); near(Math.hypot(r.x - 13, r.y - 53), 3);
  assert.equal(S(0.4, 40).name, 'Left wall'); assert.equal(S(119.8, 79.8).kind, 'corner'); assert.equal(S(25, 40).kind, 'floor'); assert.equal(S(25, 40).snapped, false);
  const o = S(-5, 200, 0.5); assert.deepEqual([o.x, o.y], [0, 80]);
  assert.equal(V.snapWords(S(40.4, 10.3)), 'corner of Stage'); assert.equal(V.snapWords(S(25, 40)), 'a point on the floor');
});
await t('3c shape to shape gaps: boxes, turned boxes, circles, touching, inside', () => {
  const g = (a, b) => V.gapBetween(V.geo(a), V.geo(b)).ft;
  near(g(IT('dj', 0, 0, 10, 10), IT('dj', 15, 0, 10, 10)), 5); near(g(IT('dj', 0, 0, 10, 10), IT('dj', 13, 14, 10, 10)), 5);
  near(g(IT('table', 0, 0, 6, 6), IT('table', 10, 0, 6, 6)), 4); near(g(IT('table', 0, 0, 6, 6), IT('dj', 10, 0, 6, 6)), 4); near(g(IT('dj', 10, 0, 6, 6), IT('table', 0, 0, 6, 6)), 4);
  near(g(IT('dj', 0, 0, 10, 10, { rotation: 45 }), IT('dj', 20, 0, 10, 10)), 15 - Math.hypot(5, 5), 0.02);
  assert.equal(g(IT('dj', 0, 0, 10, 10), IT('dj', 5, 5, 10, 10)), 0); assert.equal(g(IT('stage', 0, 0, 40, 20), IT('mandap', 10, 5, 8, 8)), 0);
  near(g(IT('table', 0, 0, 6, 6, { properties: { shape: 'square' } }), IT('table', 10, 8, 6, 6, { properties: { shape: 'square' } })), Math.hypot(4, 2));
});
await t('3d one item: the 4 walls and the nearest item on each side (the planner\'s Measure rule), turned 90 degrees too', () => {
  const items = [IT('stage', 40, 10, 40, 16, { id: 's' }), IT('dancefloor', 48, 30, 24, 12, { id: 'd' }), IT('dj', 90, 12, 8, 5, { id: 'j' }), IT('bar', 100, 12, 8, 5, { id: 'far' }), IT('longtable', 10, 20, 20, 4, { id: 'l', rotation: 90 })];
  const gs = items.map(V.geo), d = V.itemDistances(gs[0], gs, W80);
  assert.deepEqual(d.walls.map((w) => w.ft), [40, 40, 10, 54]); assert.deepEqual(d.near.map((n) => [n.side, n.id, n.ft]), [['left', 'l', 18], ['right', 'j', 10], ['below', 'd', 4]]);
  const l = V.itemDistances(gs[4], gs, W80); assert.deepEqual(l.walls.map((w) => w.ft), [18, 98, 12, 48]);
});
const HALL = { world: { w: 120, h: 80 }, unit: 'ft', margins: { left: 2, right: 2, top: 2, bottom: 2 }, hall: { len: 120, wid: 80 }, items: [
  IT('stage', 40, 2, 40, 16, { label: 'Main stage' }), IT('mandap', 52, 4, 16, 12, { label: 'Mandap' }), IT('dancefloor', 48, 20, 24, 12, { label: 'Dance floor' }),
  IT('seatblock', 20, 40, 36, 24, { label: 'Left', category: 'seating', properties: { rows: 10, cols: 14 } }), IT('seatblock', 64, 40, 36, 24, { label: 'Right', category: 'seating', properties: { rows: 10, cols: 14 } }),
  IT('table', 2, 2, 6, 6, { label: 'T1', properties: { seats: 10 } }), IT('table', 11, 2, 6, 6, { label: 'T2', properties: { seats: 10 } }),
  IT('redcarpet', 57, 34, 6, 40, { label: 'Aisle' }), IT('exit', 108, 64, 12, 6, { label: 'Exit', category: 'safety' }) ] };
await t('3e key distances: hall, usable area, stage to first seats / dance floor / walls, aisle, walkway, tables, side aisles, exits', () => {
  const K = V.keyDistances(D.prepare(HALL)), by = (l) => (K.find((k) => k.label === l) || {}).ft;
  assert.equal(by('Hall, left to right'), 120); assert.equal(by('Hall, top to bottom'), 80); assert.equal(by('Usable area, left to right'), 116);
  assert.equal(by('Main stage to the first seats'), 22); assert.equal(by('Main stage to the dance floor'), 2); assert.equal(by('Main stage to the top wall'), 2); assert.equal(by('Dance floor to the nearest seats'), 8);
  assert.equal(by('Aisle width (Aisle)'), 6); assert.equal(by('Walkway, Left to Right'), 8); assert.equal(by('Closest tables, T1 and T2'), 3);
  assert.equal(by('Seats to the left wall'), 2); assert.equal(by('Seats to the right wall'), 20); near(by('Exit clear to Right'), 8);
  assert.ok(K.find((k) => k.label === 'Seats to the left wall').warn, 'under 4 ft is marked'); assert.ok(!K.find((k) => k.label === 'Walkway, Left to Right').warn);
  assert.ok(!K.some((k) => /^Mandap to/.test(k.label)), 'a mandap standing on the stage is the stage');
  K.forEach((k) => { if (k.a && k.b && k.key !== 'x') near(Math.hypot(k.a.x - k.b.x, k.a.y - k.b.y), k.ft, 0.02); });
  // the same numbers as the card's "Sizes and counts"
  const W = {}; vm.runInNewContext(EF, { window: W, Intl, Date, Math, Number, String, Object, Array, JSON, isFinite, Infinity, Promise }); const m = W.HelmEventFloor.measure(HALL), row = (k) => (m.rows.find((r) => r[0] === k) || [])[1];
  assert.equal(row('Walkway between seating blocks'), '8 ft'); assert.equal(row('Stage to the first seats'), '22 ft');
  assert.deepEqual(V.keyDistances(D.prepare({ items: [] })).map((k) => k.key), ['hall-w', 'hall-h'], 'an empty hall gives only the hall');
});
await t('3f big plan: 400 tables measured fast; nothing invented', () => {
  const items = []; for (let i = 0; i < 400; i++) items.push(IT('table', (i % 25) * 9, Math.floor(i / 25) * 9, 6, 6, { id: 'b' + i, label: 'T' + i, properties: { seats: 8 } }));
  const p = plan({ world: { w: 260, h: 180 }, items }), t0 = Date.now(), K = V.keyDistances(p), gs = p.items.map(V.geo); for (let i = 0; i < 200; i++) V.snap({ x: i, y: i % 100 }, gs, p.world, 2);
  assert.ok(Date.now() - t0 < 1500, (Date.now() - t0) + ' ms'); assert.equal(K.find((k) => k.key === 'tables').ft, 3);
});
await t('3g labels never cover each other, stay on screen, and are left out (never stacked) when there is no room', () => {
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (const [w, h] of [[375, 812], [812, 375], [1440, 900]]) for (let k = 0; k < 40; k++) {
    const L = Array.from({ length: 9 }, () => { const ax = rnd() * w, ay = rnd() * h; return { ax, ay, bx: Math.min(w, ax + rnd() * 200), by: Math.min(h, ay + rnd() * 200), w: 60 + rnd() * 60, h: 46 }; });
    const busy = [{ x: w - 160, y: 10, w: 150, h: 44 }], P = V.placeLabels(L, { x: 6, y: 6, w: w - 12, h: h - 12 }, busy), rs = P.filter(Boolean).map((p) => p.r);
    rs.forEach((r, i) => { assert.ok(r.x >= 5.9 && r.y >= 5.9 && r.x + r.w <= w - 5.9 && r.y + r.h <= h - 5.9, 'on screen'); rs.concat(busy).forEach((q, j) => { if (i !== j) assert.ok(!(r.x < q.x + q.w && q.x < r.x + r.w && r.y < q.y + q.h && q.y < r.y + r.h), 'overlap'); }); });
  }
  assert.deepEqual(V.clipLine({ x: -50, y: 10 }, { x: 50, y: 10 }, { x: 0, y: 0, w: 100, h: 100 }), [{ x: 0, y: 10 }, { x: 50, y: 10 }]); assert.equal(V.clipLine({ x: -50, y: -10 }, { x: 50, y: -10 }, { x: 0, y: 0, w: 100, h: 100 }), null);
});

await t('4a the card: the exact plan + one Layout button with 2D plan, 3D view, Measure, Full screen; print pack kept; plain drawing as the fallback', () => {
  assert.match(EF, /if \(d === doc && !o\.plain && global\.HelmFloorDraw\)/); assert.match(EF, /FV\.menuButton\(\{ label: "Layout"/); assert.match(EF, /printLink\(qid\)/); assert.match(EF, /"🖨 Print event-day pack"/);
  assert.ok(!/text: "Open 2D plan"|text: "📏 Measure"/.test(EF), 'the old row of buttons is gone');
  assert.match(FV, /MODES = \[\["2d", "2D plan"\], \["3d", "3D view"\], \["measure", "Measure"\]\]/); assert.match(FV, /"Full screen"/);
  assert.match(EF, /planSvg\(doc, f, \{ plain: true \}\)/); assert.match(EF, /eventType: o\.eventType \|\| ""/);
});
await t('4a2 an empty layout: one clear line, no version next to "nothing saved", no view buttons, Edit only for roles that may', () => {
  const W = {}; vm.runInNewContext(EF, { window: W, Intl, Date, Math, Number, String, Object, Array, JSON, isFinite, Infinity, Promise }); const E = W.HelmEventFloor;
  assert.equal(E.emptyWords({ version_no: 1, saved_at: '2026-10-16T17:51:00Z', items: [] }), 'The saved layout (V1, 16 Oct) is empty - nothing is placed on it yet.');
  assert.equal(E.emptyWords({ version_no: null, items: [] }), 'No layout yet.'); assert.equal(E.emptyWords(null), 'No layout yet.');
  const src = EF.slice(EF.indexOf('function renderFloor('), EF.indexOf('// R253: only the plan')), empty = src.slice(src.indexOf('if (!mz.items) {'));
  assert.ok(!/viewUrl|menuButton|version_no|Opens view only/.test(empty)); assert.match(empty, /mayEdit\(\)\.then/); assert.match(empty, /if \(!lk\.locked\)/); assert.match(src, /mz\.items \? h\("span", \{ cls: "ef-meta"/);
  assert.match(EF, /canEditArea\("layouts"\)/); assert.ok(!/No floor plan saved yet|Opens view only/.test(EF));
});
await t('4b the viewer: plan only, dialog, focus kept inside and given back, Escape, page behind is inert, full screen with a fallback', () => {
  for (const re of [/role: "dialog", "aria-modal": "true"/, /n\.inert = true/, /n\.inert = false/, /back\.focus\(/, /function trap\(e\)/, /requestFullscreen \|\| root\.webkitRequestFullscreen/, /if \(!f\) \{ setFake\(true\); return; \}/, /e\.key === "Escape"/, /aria-live/]) assert.match(FV, re);
  assert.ok(!/h\("(header|nav|aside|table)"/.test(FV), 'no headers / side bars');
  for (const re of [/"pinch"/, /onWheel/, /function dbl\(/, /gesturestart/, /pointercancel/, /ResizeObserver/]) assert.match(FV, re);
});
await t('4c read-only: no store call that writes, nothing kept, no photo render, DOM calls only, no inline style attributes', () => {
  assert.deepEqual([...new Set([...FV.matchAll(/\bB\.(\w+)\.(\w+)/g)].filter((m) => !/^(cv|out)$/.test(m[1])).map((m) => m[1] + '.' + m[2]))].sort(), ['org.identity', 'sites.mediaUrls'], 'only the two reads a screen\'s logo needs');
  assert.ok(!/localStorage|sessionStorage|indexedDB|fetch\(|\.rpc\(|\.update\(|\.insert\(|saveLayout|putImage/.test(FV));
  assert.ok(!/photo-render|__capture3D/.test(FV + EF)); assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(FV + EF));
  assert.ok(!/setAttribute\("style"|style: "/.test(FV));
});
await t('4d 3D only when asked for, friendly without WebGL, asks first on a small phone, frees its memory', () => {
  assert.match(FV, /"\/floor-3d\.js\?v=\d+"/); assert.match(FV, /function load3D\(\)/); assert.ok(!/floor-3d|three/.test(EF), 'the card never loads 3D');
  assert.match(FV, /3D is not available on this device or browser\. The 2D plan and Measure still work\./); assert.match(FV, /navigator\.deviceMemory/); assert.match(FV, /WEBGL_lose_context/); assert.match(FV, /webglcontextlost/);
  for (const p of ['"Overview"', '"Top"', '"Entrance"', '"Stage"']) assert.ok(FV.includes(p), p);
});
await t('4e CSS: tokens for the chrome, 44 px targets, reduced motion, safe areas, landscape; measure colours at 4.5:1 on the sheet', () => {
  const lum = (h) => { const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const cr = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  for (const k of ['--fv-m', '--fv-wall', '--fv-key']) { const v = new RegExp(k + ':(#[0-9a-f]{6})').exec(CSS)[1]; assert.ok(cr(v, '#f4f7fd') >= 4.5 && cr(v, '#ffffff') >= 4.5, k); }
  assert.equal(new RegExp('--fv-sheet:(#[0-9a-f]{6})').exec(CSS)[1], D.PALETTE['--canvas']);
  assert.match(CSS, /min-height:44px;min-width:44px/); assert.match(CSS, /prefers-reduced-motion:reduce/); assert.match(CSS, /safe-area-inset-bottom/); assert.match(CSS, /orientation:landscape/); assert.match(CSS, /--fv-acc:var\(--tc-acc,/);
  assert.ok(!/#047857|#10b981|#059669/i.test(CSS + EFCSS), 'no hard-coded green');
});
await t('4f files load by absolute path with a version (studio paths /<studio>/ops work)', () => {
  for (const m of (FV + EF).matchAll(/"([^"]*\.(?:js|css))\?v=(\d+)"/g)) assert.match(m[1], /^\//, m[1]);
  for (const [f, host] of [['builder-tools.js', 'builder.html'], ['stage-screen.js', 'builder.html'], ['capture-frame.js', 'builder.html'], ['dancers-3d.js', 'builder.html']]) {
    const a = new RegExp(f.replace('.', '\\.') + '\\?v=(\\d+)').exec(FV)[1], b = new RegExp(f.replace('.', '\\.') + '\\?v=(\\d+)').exec(read('public/' + host))[1]; assert.equal(a, b, f + ' same version as the planner'); }
});
console.log('\nR253 layout viewer: ' + pass + ' passed, ' + fail + ' failed'); if (fail) process.exit(1);
