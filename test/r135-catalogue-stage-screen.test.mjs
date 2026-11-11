// R135: the owner's visual asset catalogue (61 assets) mapped onto the layout builder, stage stairs + built-in
// steps, and the customizable stage / LED screen (5 themes, text fields, builder-only placeholder).
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const b = read('public/builder.js'), b3 = read('public/builder-3d.js'), sa = read('public/store-api.js'), cc = read('public/control.html');
const grid = read('public/asset-price-grid.js'), doc = read('docs/builder/R135-CATALOGUE-MAP.md'), html = read('public/builder.html');
const HS = require('../public/stage-screen.js');
const P = require('../public/photo-render-prompt.js');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name); };

const objAt = (src, head, end = '\n};') => { const i = src.indexOf(head); assert.ok(i >= 0, head); return src.slice(i + head.length - 1, src.indexOf(end, i) + end.length - 1); };
const ASSETS = new Function('return ' + objAt(b, 'const ASSETS = {'))();
const META = new Function('return ' + objAt(b, 'const PRODUCT_META = {'))();
const VS = new Function('return ' + objAt(b, 'const VARIANT_STYLES = {').replace(/ENTRANCE_STYLES/g, '[]'))();
const VX = new Function('return ' + objAt(b, 'const VARIANT_EXTRA = {'))();
const DEF = new Function('return {' + b.match(/const DEFAULT_PRICES = \{[^\n]*\n([\s\S]*?)\n\};/)[1] + '}')();
const OBJ = new Function('return {' + sa.match(/const OBJECT_PRICE = \{\n([\s\S]*?)\n  \};/)[1] + '}')();
const CAT = new Function('return ' + cc.match(/const ITEM_CATALOG = (\[[\s\S]*?\n  \]);/)[1])();
const NEW = ['lawnfloor', 'stagelight', 'pathlights', 'sidescreen', 'stagedeck', 'stagestairs', 'installation'];

// the mapping table lives in the doc (one row per catalogue asset)
const rows = [...doc.matchAll(/^\| (0\d) [^|]+\| ([^|]+) \| (duplicate|variant|new) \| `([a-z]+)` \| ([^|]+) \|$/gm)]
  .map((m) => ({ cat: m[1], name: m[2].trim(), kind: m[3], type: m[4], look: m[5].trim() }));

t('every one of the 61 catalogue assets is mapped (8 / 21 / 8 / 9 / 9 / 6) to a real builder item', () => {
  assert.equal(rows.length, 61);
  const per = {}; rows.forEach((r) => { per[r.cat] = (per[r.cat] || 0) + 1; });
  assert.deepEqual(per, { '01': 8, '02': 21, '03': 8, '04': 9, '05': 9, '06': 6 });
  for (const r of rows) assert.ok(ASSETS[r.type], r.name + ' -> ' + r.type);
  for (const want of ['Single continuous carpet (without barricades)', 'Outdoor lawn flooring', 'Triangle truss', 'LED rope lights', 'VIP seating',
    'Stage stairs', 'LED side screens', 'Canopy tents (multiple styles)', 'Booth partitions']) assert.ok(rows.some((r) => r.name === want), want);
  const k = { duplicate: 0, variant: 0, new: 0 }; rows.forEach((r) => k[r.kind]++);
  assert.deepEqual(k, { duplicate: 30, variant: 24, new: 7 });
  assert.match(doc, /30 duplicates, 24 variants, 7 new items/);
  assert.deepEqual([...new Set(rows.filter((r) => r.kind === 'new').map((r) => r.type))].sort(), [...NEW].sort());
});

t('every variant row points at a real look option of that item', () => {
  for (const r of rows.filter((x) => x.kind === 'variant' || /style=/.test(x.look))) {
    for (const part of r.look.split(/\s*\/\s*/)) {
      const m = part.match(/^(?:(style|carpet|edge)=)?([a-z]+)/); assert.ok(m, r.name + ' look ' + part);
      const key = m[1] || 'style', v = m[2];
      const opts = key === 'style' ? (VS[r.type] || []) : ((VX[r.type] || []).find((f) => f[0] === key) || [, , []])[2];
      assert.ok(opts.some((o) => o[0] === v), r.name + ': ' + r.type + ' ' + key + '=' + v);
    }
  }
  // the carpet options the owner listed
  assert.deepEqual(VX.redcarpet.find((f) => f[0] === 'carpet')[2].map((o) => o[0]), ['', 'white', 'ivory', 'gold']);
  assert.deepEqual(VX.redcarpet.find((f) => f[0] === 'edge')[2].map((o) => o[0]), ['', 'none']);
  assert.match(b, /\(VARIANT_EXTRA\[type\]\|\|\[\]\)\.forEach\(x=>f\.push\(x\)\)/, 'extra looks reach the inspector');
});

t('new items are wired everywhere: toolbox, search words, both default prices, Settings, price grid, 2D, glyph, 3D, render phrase', () => {
  const sym0 = b.indexOf('function renderItem('), sym1 = b.indexOf('function renderSelection(', sym0), g0 = b.indexOf('function assetGlyph(');
  const prem = b3.slice(b3.indexOf('function buildPremium('), b3.indexOf('  function buildFurniture('));
  const catMap = Object.fromEntries(CAT.map(([k, , p]) => [k, p]));
  const sections = new Function('return ' + objAt(b, 'const TOOLBOX_SECTIONS = [', '\n];'))();
  for (const ty of NEW) {
    assert.ok(META[ty] && META[ty][1].split(' ').length >= 4, 'search words ' + ty);
    assert.ok(DEF[ty] > 0 && DEF[ty] === OBJ[ty] && catMap[ty] === DEF[ty], 'price in builder + store-api + Settings ' + ty);
    assert.ok(new RegExp('\\b' + ty + '\\b').test(grid), 'price grid group ' + ty);
    assert.ok(b.slice(sym0, sym1).includes("case '" + ty + "'"), '2D ' + ty);
    assert.ok(b.slice(g0, g0 + 30000).includes("case '" + ty + "'"), 'glyph ' + ty);
    assert.ok(prem.includes("case '" + ty + "'"), '3D ' + ty);
    assert.ok(P.DESCRIPTIONS[ty] && P.DESCRIPTIONS[ty].length > 12, 'render phrase ' + ty);
    assert.ok(sections.some(([, list]) => list.includes(ty)), 'toolbox section ' + ty);
    const a = ASSETS[ty]; assert.ok(a.w >= 1 && a.h >= 1 && a.w <= 40 && a.h <= 24, 'real-world size ' + ty);
  }
  assert.ok(sections.find(([nm]) => nm === 'Stage & presentation')[1].includes('stagestairs'));
});

/* ---- stairs + built-in steps (pure functions lifted from builder.js / builder-3d.js) ---- */
const fnSrc = (src, name) => { const i = src.indexOf('function ' + name + '('); assert.ok(i >= 0, name); let d = 0, j = src.indexOf('{', i);
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}' && --d === 0) break; } return src.slice(i, j + 1); };
const clamp = (v, a, z) => Math.max(a, Math.min(z, v));
const stepOff = new Function('clamp', fnSrc(b, 'stageStepOffsets') + '; return stageStepOffsets;')(clamp);
const stepXs = new Function(fnSrc(b3, 'stepXs') + '; return stepXs;')();
const snap = new Function('clampItem', fnSrc(b, 'snapStairsToStage') + '; return snapStairsToStage;')(() => {});
const stairN = new Function('clamp', fnSrc(b, 'stairStepCount') + '; return stairStepCount;')(clamp);

t('stage built-in steps: default (no property) is the old centre set; left / right / both / none in 2D and 3D alike', () => {
  for (const f of [stepOff, stepXs]) {
    assert.deepEqual(f(undefined, 40, 8), [0]); assert.deepEqual(f('', 40, 8), [0]); assert.deepEqual(f('bogus', 40, 8), [0]);
    assert.deepEqual(f('left', 40, 8), [-16]); assert.deepEqual(f('right', 40, 8), [16]); assert.deepEqual(f('both', 40, 8), [-16, 16]); assert.deepEqual(f('none', 40, 8), []);
  }
  assert.match(b, /stageStepOffsets\(it\.properties&&it\.properties\.builtinSteps, w, sw\)/);
  assert.match(b3, /stepXs\(String\(\(it\.properties\|\|\{\}\)\.builtinSteps\|\|''\), w, sw\)/);
  // an old saved stage (no builtinSteps) still draws exactly the 3 centred tread lines it always did
  assert.match(b, /for\(let i=1;i<=3;i\+\+\) body\.appendChild\(el\('line',\{x1:ox-sw\/2,y1:h\/2\+i\*3\.4/);
  assert.match(b, /const STAGE_STEPS=\[\['','Centre \(default\)'\]/);
});

t('stage stairs snap to the front edge of a stage at left / centre / right, following its rotation; 2-6 steps', () => {
  const stage = { type: 'stage', x: 80, y: 20, width: 40, height: 16, rotation: 0 };
  const st = (pos) => ({ type: 'stagestairs', x: 0, y: 0, width: 6, height: 3.3, rotation: 0, properties: { stairPos: pos } });
  const c = st('centre'); assert.equal(snap(c, stage), true);
  assert.deepEqual([c.x, c.y, c.rotation], [97, 36, 0]);   // centred under the stage front (y 20+16)
  const l = st('left'); snap(l, stage); assert.deepEqual([l.x, l.y], [80, 36]);
  const r = st('right'); snap(r, stage); assert.deepEqual([r.x, r.y], [114, 36]);
  const rot = st('centre'), s90 = Object.assign({}, stage, { rotation: 90 }); snap(rot, s90);
  assert.equal(rot.rotation, 90); assert.ok(Math.abs(rot.x + 3 - (100 - 9.65)) < 1e-9 && Math.abs(rot.y + 1.65 - 28) < 1e-9, 'front edge of a rotated stage');
  assert.equal(snap(st('left'), null), false, 'no stage: stays put');
  assert.equal(stairN({ properties: {} }), 3); assert.equal(stairN({ properties: { stairSteps: 9 } }), 6); assert.equal(stairN({ properties: { stairSteps: 1 } }), 2);
  assert.deepEqual(ASSETS.stagestairs.props, { stairPos: 'centre', stairSteps: 3 });
  assert.match(b, /P\(\)\.stairSteps=clamp\(parseInt\(v,10\)\|\|3,2,6\); it\.height=clamp\(P\(\)\.stairSteps\*1\.1/);
});

/* ---- the screen model ---- */
t('5 themes + the current look; screen text is sanitised, length-capped and theme-whitelisted', () => {
  // R137 added three themes after these (test/r137-stage-screen-logo-dancers.test.mjs); the R135 six keep their order
  assert.deepEqual(HS.THEME_ORDER.slice(0, 6), ['', 'corporate', 'royal', 'floral', 'minimal', 'neon']);
  assert.equal(Object.keys(HS.THEMES).filter(Boolean).length, 8);
  for (const k of HS.THEME_ORDER) { const T = HS.THEMES[k]; assert.ok(T.name && /^#[0-9a-f]{6}$/.test(T.bg) && /^#[0-9a-f]{6}$/.test(T.ink), k); }
  assert.equal(HS.THEMES[''].bg, '#2f6fed', 'blank theme = the blue screen the builder always drew');
  const p = { title: '  Annual   Day <script>alert(1)</script> ' + 'x'.repeat(80), brand: 42, tagline: '\u0000\u0007 ok', subtitle: '   ', screenTheme: '__proto__', screenMirror: 'yes', seats: 8 };
  HS.sanitize(p);
  assert.ok(p.title.length <= 60 && !/[<>]/.test(p.title) && p.title.startsWith('Annual Day'));
  assert.equal(p.brand, undefined); assert.equal(p.tagline, 'ok'); assert.equal(p.subtitle, undefined);
  assert.equal(p.screenTheme, undefined); assert.equal(p.screenMirror, undefined); assert.equal(p.seats, 8, 'other props untouched');
  const q = HS.sanitize({ screenTheme: 'royal', screenMirror: true, brand: 'CRISKA' }); assert.deepEqual(q, { screenTheme: 'royal', screenMirror: true, brand: 'CRISKA' });
  assert.match(b, /window\.HelmScreen\.sanitize\(it\.properties\);/, 'stored / imported layouts are sanitised on load');
  assert.equal(HS.monogram('  criska'), 'C'); assert.equal(HS.monogram('—'), '');
  assert.equal(HS.shortLine({ brand: 'CRISKA', title: 'Annual Day' }), 'CRISKA · Annual Day');
});

t('screen types + "Same as main screen" mirrors the stage; old layouts have no content (unchanged look)', () => {
  for (const ty of ['stage', 'ledscreen', 'sidescreen', 'videowall', 'led', 'brandwall', 'backdrop']) { assert.ok(HS.isScreenType(ty), ty); assert.ok(ASSETS[ty], ty); }
  assert.equal(HS.isScreenType('table'), false); assert.equal(HS.contentOf({ type: 'table' }, []), null);
  const stage = { type: 'stage', properties: { screenTheme: 'corporate', brand: 'CRISKA', title: 'Annual Day' } };
  const side = { type: 'sidescreen', properties: { screenMirror: true, brand: 'Other' } };
  const c = HS.contentOf(side, [stage, side]); assert.equal(c.brand, 'CRISKA'); assert.equal(c.theme, 'corporate'); assert.equal(c.mirrored, true);
  assert.equal(HS.contentOf({ type: 'sidescreen', properties: { brand: 'Own' } }, [stage]).brand, 'Own');
  assert.equal(HS.hasContent(HS.contentOf({ type: 'stage', properties: {} }, [])), false, 'an old stage shows the old screen');
  assert.equal(HS.hasContent(HS.contentOf({ type: 'stage' }, [])), false);
});

t('canvas drawing (3D texture): text only via fillText, title + brand drawn, side panel repeats brand + tagline', () => {
  const drawn = [], grad = { addColorStop() {} };
  const ctx = new Proxy({ fillText: (s) => drawn.push(s), measureText: (s) => ({ width: s.length * 10 }), createLinearGradient: () => grad }, { get: (o, k) => (k in o ? o[k] : () => {}), set: () => true });
  for (const th of HS.THEME_ORDER) { drawn.length = 0; HS.draw(ctx, 1024, 512, HS.rawContent({ screenTheme: th, brand: 'CRISKA', title: 'Annual Day', tagline: 'Building intelligent futures', subtitle: 'Celebrating success, together', dateLine: '12 Dec' }));
    for (const s of ['CRISKA', 'Annual Day', 'BUILDING INTELLIGENT FUTURES', 'CELEBRATING SUCCESS, TOGETHER', '12 Dec', 'C']) assert.ok(drawn.includes(s), th + ': ' + s); }
  drawn.length = 0; HS.draw(ctx, 384, 1024, HS.rawContent({ brand: 'CRISKA', tagline: 'Building' }), { side: true });
  assert.ok(drawn.includes('CRISKA') && drawn.includes('BUILDING'));
  const src = read('public/stage-screen.js'); assert.ok(!/innerHTML|insertAdjacentHTML|eval\(|new Function/.test(src), 'no HTML sinks');
});

t('placeholder is builder-only: never in exports, the capture host, read-only views, 3D or the photo render', () => {
  assert.match(b, /function screenPlaceholderOn\(\)\{ return !RO && !document\.querySelector\('meta\[name="helm-capture"\]'\); \}/);
  assert.match(b, /clone\.querySelectorAll\('\.scr-ph'\)\.forEach\(n=>n\.remove\(\)\);/, 'planBlob strips it from every picture');
  assert.ok(b.indexOf("clone.querySelectorAll('.scr-ph')") < b.indexOf('new XMLSerializer().serializeToString(clone)'));
  assert.ok(!b3.includes('PLACEHOLDER') && !b3.includes('Tap to add'), '3D never draws the hint');
  const items = [{ id: 's1', type: 'stage', x: 80, y: 2, width: 40, height: 16, rotation: 0, properties: {} }];
  const pr = P.build({ items, world: { w: 200, h: 140 } }).prompt;
  assert.ok(!/Tap to add|Your event name/.test(pr)); assert.match(pr, /without readable or misleading text/);
  const r2 = P.build({ items: [{ ...items[0], properties: { screenTheme: 'royal', brand: 'Sita & Ram', title: 'Reception' } },
    { id: 'l1', type: 'sidescreen', x: 60, y: 2, width: 6, height: 1.5, rotation: 0, properties: { screenMirror: true } }], world: { w: 200, h: 140 } }).prompt;
  assert.match(r2, /backdrop screen in a royal maroon and gold theme with a gold border showing exactly the words "Sita & Ram", "Reception"/);
  assert.match(r2, /the screen in a royal maroon and gold theme/, 'mirrored side screen copies the stage');
  assert.match(r2, /EXCEPT the exact screen words listed below/);
  const r3 = P.build({ items: [{ ...items[0], properties: { title: 'A <b>"x"</b>\u0007' } }], world: { w: 200, h: 140 } }).prompt;
  assert.ok(!/<b>/.test(r3) && /"A b 'x' \/b"/.test(r3), 'cleaned + quoted');
});

t('inspector Screen / steps / stairs sections use the DOM API only (CSP + Trusted Types), live in 2D + 3D', () => {
  const blk = b.slice(b.indexOf('R135 STAGE STEPS + STAIRS + SCREEN: BEGIN'), b.indexOf('R135 STAGE STEPS + STAIRS + SCREEN: END'));
  assert.ok(blk.length > 2000); assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(blk), 'no HTML sinks');
  assert.match(blk, /inp\.maxLength=S\.MAX/); assert.match(blk, /S\.THEME_ORDER\.forEach/); assert.match(blk, /Same as main screen/);
  assert.match(blk, /inp\.addEventListener\('input',\(\)=>\{ if\(RO\) return; apply\(\); live\(\); \}\);/);
  assert.match(b, /stageScreenMount\(it, box\);/);
  const helpers = b.slice(b.indexOf('function screenContent('), b.indexOf('function renderItem('));
  assert.ok(!/innerHTML/.test(helpers) && /t\.textContent=fitChars/.test(helpers), '2D screen text via textContent');
  assert.match(html, /<script src="stage-screen\.js\?v=\d+"><\/script>\n<script src="builder\.js\?v=\d+"><\/script>/, 'loaded before builder.js');
  for (const f of ['public/capture.html', 'public/try.html']) assert.match(read(f), /stage-screen\.js\?v=\d+/, f);
  assert.match(read('public/page-tours.js'), /title: "Stage screen, steps & stairs"/); 
});

t('3D screen textures: one cached CanvasTexture per screen, redrawn on change, old ones disposed', () => {
  assert.match(b3, /if\(hit && hit\.key===key\) return hit\.tex;\n\s+if\(hit && hit\.tex\) hit\.tex\.dispose\(\);/);
  assert.match(b3, /function pruneScreenTextures\(\)\{ SCREEN_TEX\.forEach\(\(v,k\)=>\{ if\(!screenSeen\.has\(k\)\)\{ if\(v\.tex\) v\.tex\.dispose\(\);/);
  assert.match(b3, /pruneScreenTextures\(\);   \/\/ R135/);
  // no content -> the stage keeps its original blue screen box
  assert.match(b3, /\} else \{\n\s+const scr=boxMesh\(w\*0\.42,bh\*0\.45,0\.15,'#2f6fed'/);
});

/* ---- smoke-run the premium 3D kit with screen content + every new look (stub THREE, like builder-catalogue-complete) ---- */
t('3D models build for every new item, every new look and a themed screen without throwing', () => {
  const k0 = b3.indexOf('  /* ---------------- premium model kit'), k1 = b3.indexOf('  function buildFurniture(');
  const f0 = b3.indexOf('  function buildFurniture('), f1 = b3.indexOf('  /* ---------------- label sprites', f0);
  const ch0 = b3.indexOf('  function chairGeometry(){'), ch1 = b3.indexOf('  /* ---------------- per-type furniture builders');
  class V { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; } set(x, y, z) { Object.assign(this, { x, y, z }); return this; } setScalar() { return this; } copy() { return this; } }
  class Obj { constructor() { this.position = new V(); this.rotation = new V(); this.scale = new V(1, 1, 1); this.children = []; this.material = { clone: () => ({}) }; } add(o) { assert.ok(o, 'added'); this.children.push(o); } clone() { return new Obj(); } traverse() {} }
  class Geo { constructor() { this.attributes = { position: { count: 4, getX: () => 1, setX() {}, setZ() {} } }; } translate() { return this; } rotateX() { return this; } dispose() {} computeVertexNormals() {} }
  const THREE = new Proxy({ Group: Obj, Vector3: V, Vector2: V, Color: class {},
    Mesh: class extends Obj { constructor(g, m) { super(); assert.ok(g && m, 'mesh needs geometry + material'); } },
    InstancedMesh: class extends Obj { constructor(g, m, c) { super(); assert.ok(c > 0); this.instanceMatrix = {}; this.instanceColor = {}; } setMatrixAt() {} setColorAt() {} },
    Matrix4: class { compose() {} }, Quaternion: class { setFromEuler() {} }, Euler: class { set() {} }, QuadraticBezierCurve3: class {},
    MeshStandardMaterial: class { dispose() {} }, MeshBasicMaterial: class { dispose() {} },
    BufferGeometryUtils: { mergeGeometries: () => new Geo() }, DoubleSide: 2 }, { get: (o, k) => (k in o ? o[k] : Geo) });
  globalThis.window = { HelmScreen: HS }; globalThis.store = { items: [] };
  try {
    const kit = new Function('THREE', 'rotOff', `
      const col=c=>({c}); const mat=(c,o)=>({c,o}); const markShadows=()=>{}; const congestionOf=()=>0; const CONG_COLORS={}; function buildModelGroup(){ return null; }
      function boxMesh(){ return new THREE.Mesh(new THREE.BoxGeometry(), {}); }
      ${b3.slice(ch0, ch1)}
      ${b3.slice(k0, k1)}
      ${b3.slice(f0, f1)}
      return { buildFurniture };`)(THREE, (x, y) => [x, y]);
    const sizes = ASSETS;
    const looks = [];
    for (const [ty, opts] of Object.entries(VS)) for (const [v] of opts) looks.push([ty, { style: v }]);
    for (const [ty, fields] of Object.entries(VX)) for (const [key, , opts] of fields) for (const [v] of opts) looks.push([ty, { [key]: v }]);
    looks.push(['redcarpet', { style: 'curved', edge: 'none', carpet: 'gold' }]);
    const screen = { screenTheme: 'corporate', brand: 'CRISKA', title: 'Annual Day', tagline: 'Building intelligent futures' };
    for (const ty of ['stage', 'ledscreen', 'sidescreen', 'videowall', 'led', 'brandwall', 'backdrop']) { looks.push([ty, { ...screen }]); looks.push([ty, { ...screen, style: 'curvedled' }]); }
    for (const ty of NEW) looks.push([ty, {}]);
    for (const m of ['', 'left', 'right', 'both', 'none']) looks.push(['stage', { builtinSteps: m }]);
    for (const sN of [2, 4, 6]) looks.push(['stagestairs', { stairSteps: sN }]);
    for (const [ty, props] of looks) for (const scale of [1, 0.4, 2.5]) {
      const a = sizes[ty], it = { id: 'it-' + ty, type: ty, x: 10, y: 10, width: a.w * scale, height: a.h * scale, rotation: 30, color: '#c2410c', label: ty, properties: { seats: 8, ...props } };
      globalThis.store.items = [it];
      const g = kit.buildFurniture(it, []);
      assert.ok(g && g.children.length > 0, '3D ' + ty + ' ' + JSON.stringify(props));
    }
  } finally { delete globalThis.window; delete globalThis.store; }
});

console.log('r135-catalogue-stage-screen: ' + n + ' checks passed');
