// r255-a.test.mjs - R255 floor planner: usable-area lines hidden, items in a corner can be dragged, a clicked tool lands on a
// free spot, posters are white and take a picture.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const R = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const HS = createRequire(import.meta.url)('../public/stage-screen.js');
const b = R('public/builder.js'), b3 = R('public/builder-3d.js'), css = R('public/builder.css'), html = R('public/builder.html');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };
const fn = (s, name) => { const i = s.indexOf('function ' + name + '('); assert.ok(i >= 0, name); return s.slice(i, s.indexOf('\n}', i) + 2); };
const bt = { window: {}, document: undefined }; vm.createContext(bt); vm.runInContext(R('public/builder-tools.js'), bt);
const T = bt.window.HelmBuilderTools || bt.HelmBuilderTools;
const hit = (a, c) => a.x < c.x + c.width - 1e-6 && c.x < a.x + a.width - 1e-6 && a.y < c.y + c.height - 1e-6 && c.y < a.y + a.height - 1e-6;

t('1 the usable-area lines: off by default, under the items, the saved margins kept', () => {
  assert.match(b, /\nlet showMargins=false;\nfunction renderMargins\(\)\{\n  if\(!showMargins\) return;/);
  assert.match(b, /renderMargins\(\);[^\n]*\n  drawOrder2D\(store\.items\)\.forEach\(it=> svg\.appendChild/);
  assert.match(b, /margins: \{ \.\.\.\(store\.margins/); assert.match(b, /store\.margins = sanitizeMargins\(data\.margins\)/);
  assert.match(html, /id="marginsBtn" role="menuitemcheckbox" aria-checked="false"/);
  assert.match(b, /dblclick',\(\)=>\{ if\(RO \|\| !showMargins\) return;/, 'hidden lines are never reset by accident');
  const g = R('scripts/gen-floor-view.mjs'); assert.ok(!/fn\(b, 'renderMargins'\)/.test(g) && !/^\s*renderMargins\(\);/m.test(g), 'not in the viewer either');
});
t('2 dragging: touch on the shapes, the selected item of a pile moves, a tap is not a move, small items stay grabbable', () => {
  assert.match(css, /#svg \.obj \*,#svg \[data-handle\],#svg \[data-margin\]\{touch-action:none\}/);
  const pile = fn(b, 'pileAt');
  const cx = { store: { items: [{ id: 'top', width: 4, height: 4 }, { id: 'mid', width: 5, height: 5 }, { id: 'stage', width: 60, height: 20 }] }, svg: { contains: () => true }, document: {} };
  cx.document.elementsFromPoint = () => ['top', 'mid', 'stage', 'mid'].map((id) => ({ closest: () => ({ dataset: { id } }) }));
  vm.runInNewContext(pile + '\nglobalThis.f=pileAt;', cx);
  assert.deepEqual([...cx.f({ clientX: 1, clientY: 1 }, 'top')], ['top', 'mid'], 'a stage under a small item is not part of the pile');
  assert.match(b, /const under=isSelected\(id\) \? null : pile\.find\(isSelected\);/);
  assert.match(b, /Math\.hypot\(e\.clientX-drag\.px, e\.clientY-drag\.py\)<4\) return;/);
  assert.match(b, /const ox=w\/k<34 \? hh : 0, oy=h\/k<34 \? hh : 0/);
  assert.match(b3, /tmode!=='translate' \|\| transform\.dragging \|\| transform\.axis \|\| \(typeof RO!=='undefined' && RO\)/, '3D body drag: move mode only, never view-only');
});
t('3 placement: nearest free spot, no overlap, inside the hall, on the grid, existing items untouched', () => {
  const W = { w: 197, h: 131 }, items = [{ x: 69, y: 5, width: 59, height: 18 }, { x: 88, y: 25, width: 21, height: 21, rotation: 45 }, { x: 0, y: 0, width: 197, height: 131 }], keep = JSON.stringify(items);
  assert.deepEqual({ ...T.freeSpot(items, W, 4, 4, { x: 30, y: 100 }, { step: 1 }) }, { x: 28, y: 98, free: true }, 'a full-hall carpet is not an obstacle');
  const add = [];
  for (let i = 0; i < 40; i++) { const w = [20, 4, 8, 2.5][i % 4], h = [2, 4, 8, 1.5][i % 4], p = T.freeSpot(items.concat(add), W, w, h, { x: 98, y: 65 }, { step: 1 });
    assert.ok(p.free && p.x >= 0 && p.y >= 0 && p.x + w <= W.w && p.y + h <= W.h && Number.isInteger(p.x) && Number.isInteger(p.y), JSON.stringify(p));
    const it = { x: p.x, y: p.y, width: w, height: h }; [items[0], ...add].forEach((o) => assert.ok(!hit(it, o), 'overlap')); add.push(it); }
  assert.equal(JSON.stringify(items), keep);
  assert.ok(add.every((a) => Math.hypot(a.x + a.width / 2 - 98, a.y + a.height / 2 - 65) < 60), 'they stay together around the centre');
  const m = T.freeSpot([], { w: 100, h: 80 }, 6, 6, { x: 50, y: 40 }, { step: 3.28084 }); assert.ok(Math.abs(m.x / 3.28084 - Math.round(m.x / 3.28084)) < 1e-3, 'metre grid');
});
t('3 placement: a full hall says so and steps off the last one; a tight gap is still used; big halls are fast', () => {
  const full = []; for (let x = 0; x < 20; x += 5) for (let y = 0; y < 20; y += 5) full.push({ x, y, width: 5, height: 5 });
  const a = T.freeSpot(full, { w: 20, h: 20 }, 4, 4, { x: 10, y: 10 }, { step: 1 }); assert.equal(a.free, false); assert.deepEqual([a.x, a.y], [8, 8]);
  const c = T.freeSpot(full.concat({ x: 8, y: 8, width: 4, height: 4 }), { w: 20, h: 20 }, 4, 4, { x: 10, y: 10 }, { step: 1 }); assert.notDeepEqual([c.x, c.y], [8, 8]);
  const gap = full.filter((o) => !(o.x === 10 && o.y === 10)); const g = T.freeSpot(gap, { w: 20, h: 20 }, 5, 5, { x: 2, y: 2 }, { step: 1 }); assert.deepEqual([g.x, g.y, g.free], [10, 10, true]);
  const many = Array.from({ length: 3000 }, (_, i) => ({ x: (i % 60) * 16, y: Math.floor(i / 60) * 19, width: 15, height: 18 })), t0 = Date.now();
  T.freeSpot(many, { w: 1000, h: 1000 }, 14, 14, { x: 500, y: 500 }, { step: 1 }); assert.ok(Date.now() - t0 < 1500, (Date.now() - t0) + ' ms');
});
t('3 in 3D the view centre is the 3D floor point, never the hidden 2D canvas (0,0)', () => {
  const cx = { is3DActive: () => true, scrollEl: { clientWidth: 0, clientHeight: 0 }, WORLD: { w: 200, h: 120 }, window: {}, clamp: (v, a, z) => Math.min(z, Math.max(a, v)) };
  vm.runInNewContext(fn(b, 'viewCenterFt') + '\nglobalThis.f=viewCenterFt;', cx);
  assert.deepEqual({ ...cx.f() }, { x: 100, y: 60 }); cx.window.__viewCenter3D = () => ({ x: 33, y: 999 }); assert.deepEqual({ ...cx.f() }, { x: 33, y: 120 });
});
t('4 posters: which items, white by default, a picture as a storage path only', () => {
  const REF = 'a0000000-0000-4000-8000-000000000001/a0000000-0000-4000-8000-0000000000b1/a0000000-0000-4000-8000-0000000000c1.png';
  for (const type of ['hoarding', 'brandwall', 'backdrop', 'signage', 'easel', 'flagstand']) {
    const it = { type, width: 20, height: 2, properties: {} };
    assert.ok(HS.takesPicture(it) && HS.whiteFace(it), type); assert.equal(HS.hasContent(HS.contentOf(it, [])), false, type + ' is blank');
    const p = { ...it, properties: { screenMode: 'pic', screenPic: REF } }, c = HS.contentOf(p, []);
    assert.equal(c.pic, REF); assert.equal(c.poster, true); const g = HS.guidance(p, []); assert.ok(g.w > 0 && g.h > 0 && g.print, type);
    assert.equal(HS.contentOf({ ...it, properties: { screenMode: 'pic', screenPic: 'data:image/png;base64,AAAA' } }, []).pic, '', 'never an embedded picture');
  }
  assert.equal(HS.takesPicture({ type: 'signage', properties: { style: 'direction' } }), false); assert.equal(HS.takesPicture({ type: 'table' }), false);
  assert.equal(HS.whiteFace({ type: 'backdrop', properties: { style: 'greenery' } }), false); assert.equal(HS.whiteFace({ type: 'flagstand', colorCustom: true, properties: {} }), false);
  assert.equal(HS.contentOf({ type: 'hoarding', properties: { title: 'x', screenTheme: 'neon' } }, []).title, '', 'a plain poster shows a picture, never text');
  assert.equal(HS.photoSpecs([{ type: 'hoarding', width: 20, height: 2, properties: { screenMode: 'pic', screenPic: REF } }]).length, 0, 'the photo render input is unchanged for the new posters');
});
t('4 the picture upload is the existing private one: bytes checked, SVG refused, trial / read-only stopped, undoable', () => {
  const add = fn(b, 'screenPicAdd');
  assert.match(add, /const gate=picGate\(it\); if\(gate\)\{ say\(gate\); return false; \}/); assert.match(add, /S\.validatePicture\(file, head\)/); assert.match(add, /BPStore\.sites\.uploadPhoto\(currentQuoteId, named\)/); assert.match(add, /commit\(\); renderAll\(\); return true;/);
  assert.equal(HS.validatePicture({ size: 9, type: 'image/svg+xml', name: 'a.svg' }, []).ok, false);
  assert.match(b, /poster \? \(ref\?'Replace picture':'Add picture'\)/); assert.match(b, /rm=btn\('Remove picture'\)/);
  const calls = []; HS.drawPicture({ set fillStyle(v) { calls.push(v); }, fillRect() {}, drawImage() {} }, 10, 10, null, 'contain', '#ffffff'); assert.equal(calls[0], '#ffffff');
  HS.drawPicture({ set fillStyle(v) { calls.push(v); }, fillRect() {} }, 10, 10, null, 'contain'); assert.equal(calls[1], '#05070a', 'screens keep their dark bars');
});
console.log(`r255-a: ${n} ok`);
