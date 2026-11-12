// R154: (1) the Jyothi Prajwalana ceremonial lamp-lighting stand, wired like every other builder item;
// (2) screen-logo end-to-end fixes: transparent logos keep their transparency, the signed link is refreshed before it
// expires, client-image captures wait for logos to load, and exported 2D plan pictures keep the logo pixels.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const b = read('public/builder.js'), b3 = read('public/builder-3d.js'), sa = read('public/store-api.js'), cc = read('public/control.html');
const grid = read('public/asset-price-grid.js'), wt = read('public/walkthrough.js'), cf = read('public/capture-frame.js'), doc = read('docs/ITEM-PRICING-DEFAULTS.md');
const P = require('../public/photo-render-prompt.js');
const HS = require('../public/stage-screen.js');
let n = 0; const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const objAt = (src, head, end = '\n};') => { const i = src.indexOf(head); assert.ok(i >= 0, head); return src.slice(i + head.length - 1, src.indexOf(end, i) + end.length - 1); };
const fnSrc = (src, name) => { const i = src.indexOf('function ' + name + '('); assert.ok(i >= 0, name); let d = 0, j = src.indexOf('{', i);
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}' && --d === 0) break; } return src.slice(i, j + 1); };
const ASSETS = new Function('return ' + objAt(b, 'const ASSETS = {'))();
const META = new Function('return ' + objAt(b, 'const PRODUCT_META = {'))();
const VS = new Function('return ' + objAt(b, 'const VARIANT_STYLES = {').replace(/ENTRANCE_STYLES/g, '[]'))();
const DEF = new Function('return {' + b.match(/const DEFAULT_PRICES = \{[^\n]*\n([\s\S]*?)\n\};/)[1] + '}')();
const OBJ = new Function('return {' + sa.match(/const OBJECT_PRICE = \{\n([\s\S]*?)\n  \};/)[1] + '}')();
const CAT = new Function('return ' + cc.match(/const ITEM_CATALOG = (\[[\s\S]*?\n  \]);/)[1])();
const SECTIONS = new Function('return ' + objAt(b, 'const TOOLBOX_SECTIONS = [', '\n];'))();

/* ---------------- 1. Jyothi Prajwalana ---------------- */
t('Jyothi Prajwalana is a builder item with a real-world footprint (1.5 x 1.5 ft) in the Religious & cultural toolbox group', () => {
  assert.deepEqual(ASSETS.jyothi, { label: 'Jyothi Prajwalana', category: 'decor', w: 1.5, h: 1.5 });
  const sec = SECTIONS.find(([nm]) => nm === 'Religious & cultural'); assert.ok(sec[1].includes('jyothi'));
  assert.equal(SECTIONS.filter(([, l]) => l.includes('jyothi')).length, 1, 'exactly one section');
  assert.ok(sec[1].includes('diyastand'), 'the older Brass Deepam Stand stays');
});

t('search words: jyothi, prajwalana, lamp, diya, deepam, candle, inauguration all find it (builder search + synonyms)', () => {
  const words = META.jyothi[1].split(' ');
  for (const w of ['jyothi', 'prajwalana', 'lamp', 'diya', 'deepam', 'candle', 'inauguration']) assert.ok(words.includes(w), w);
  assert.equal(META.jyothi[2], '*', 'suggested for every event type');
  const cx = {}; cx.globalThis = cx; vm.createContext(cx); vm.runInContext(read('public/builder-tools.js'), cx);
  const T = cx.HelmBuilderTools, A = JSON.parse(JSON.stringify(ASSETS)); for (const k of Object.keys(A)) if (META[k]) A[k].tags = META[k][1];
  const cats = { structure: { name: 'Structure' }, seating: { name: 'Seating' }, av: { name: 'AV' }, security: { name: 'Security' }, logistics: { name: 'Logistics' }, safety: { name: 'Safety' }, decor: { name: 'Decor' } };
  for (const q of ['jyothi', 'prajwalana', 'jyothi prajwalana']) assert.equal(T.searchAssets(q, A, cats, { limit: 5 })[0].type, 'jyothi', q);
  for (const q of ['lamp', 'diya', 'deepam', 'candle', 'inauguration']) assert.ok(T.searchAssets(q, A, cats, { limit: 5 }).some((r) => r.type === 'jyothi'), q);
});

t('price: same default in the builder, the shared pricing engine and Settings -> Item pricing (+ price grid group, docs)', () => {
  assert.equal(DEF.jyothi, 3000); assert.equal(OBJ.jyothi, 3000);
  assert.deepEqual(CAT.find((r) => r[0] === 'jyothi'), ['jyothi', 'Jyothi Prajwalana', 3000]);
  assert.match(grid, /decor: "[^"]*\bjyothi\b/);
  assert.match(doc, /\| `jyothi` \| Jyothi Prajwalana \| 3,000 \|/);
});

t('2D symbol, toolbox glyph, 3D model, capture height, walkthrough + evening light, render phrase, inspector looks', () => {
  const sym0 = b.indexOf('function renderItem('), sym1 = b.indexOf('function renderSelection(', sym0), g0 = b.indexOf('function assetGlyph(');
  assert.ok(b.slice(sym0, sym1).includes("case 'jyothi'"), '2D');
  assert.ok(b.slice(g0, g0 + 30000).includes("case 'jyothi'"), 'glyph');
  const prem = b3.slice(b3.indexOf('function buildPremium('), b3.indexOf('  function buildFurniture('));
  const m3 = prem.slice(prem.indexOf("case 'jyothi'"), prem.indexOf("case 'havankund'"));
  assert.ok(m3.length > 200, '3D model');
  assert.match(m3, /lathe\(/, 'turned brass pole'); assert.match(m3, /\[\[2\.5,0\.6,7\],\[3\.6,0\.46,6\],\[4\.6,0\.32,5\]\]/, '3 tiered trays');
  assert.match(m3, /MeshBasicMaterial/, 'unlit flame = looks lit'); assert.match(m3, /'#fff4c6'/, 'hot flame core'); assert.match(m3, /'#fff2b0'/, 'bright wick bead');
  assert.match(m3, /castShadow=false/, 'flames cast no shadow'); assert.doesNotMatch(m3, /PointLight/, 'no per-lamp light (cost); Evening lighting adds one pool');
  assert.match(cf, /jyothi:5\.6\}/, 'capture framing height ~5.6 ft');
  assert.match(wt, /flagstand diyastand jyothi floralpillar/, 'rides with the stage stop, never its own stop');
  assert.match(wt, /jyothi: \['ceremonial lamp stand'\]/);
  const wcx = { window: {} }; wcx.globalThis = wcx; vm.createContext(wcx); vm.runInContext(cf, wcx); vm.runInContext(wt, wcx);
  const WT = wcx.window.HelmWalkthrough;
  const hall = { w: 100, h: 80 };
  const pts = WT.eveningLightPoints([{ id: 'j', type: 'jyothi', x: 20, y: 30, width: 1.5, height: 1.5 }], hall);
  assert.ok(pts.some((p) => p.y === 5.5 && p.r === 14), 'small warm pool at lamp height in Evening lighting');
  const full = Array.from({ length: 12 }, (_, i) => ({ id: 't' + i, type: 'table', x: i * 6, y: 10, width: 5, height: 5 })).concat([{ id: 'j', type: 'jyothi', x: 1, y: 1, width: 1.5, height: 1.5 }]);
  assert.ok(WT.eveningLightPoints(full, hall).length <= 8, 'never over the 8-light budget');
  assert.match(P.DESCRIPTIONS.jyothi, /traditional brass lamp stand with lit oil lamps/);
  const r = P.build({ eventType: 'corporate', items: [{ id: 's', type: 'stage', x: 30, y: 2, width: 30, height: 12 }, { id: 'j', type: 'jyothi', x: 20, y: 18, width: 1.5, height: 1.5, properties: { style: 'candle' } }], world: { w: 100, h: 80 } });
  assert.ok(r.prompt.includes('"t":"jyothi"')); assert.ok(r.prompt.includes('traditional brass lamp stand with lit oil lamps'));
  assert.ok(r.prompt.includes('wrought-iron stand holding lit pillar candles'), 'the candle look reaches the prompt');
  assert.deepEqual(VS.jyothi.map((o) => o[0]), ['', 'candle']);
});

t('the keynote template lights the lamp: one stand on the floor at stage left, inside the hall, clear of stage and seats', () => {
  const i0 = b.indexOf('  conference_keynote(){'), body = b.slice(i0, b.indexOf('  conference_classroom(){', i0)); assert.ok(i0 > 0);
  assert.match(body, /makeItem\('jyothi', cx-20, 24, \{label:'Jyothi Prajwalana'\}\)/);
  // stage spans y 6..20, the seat blocks start at y 34: the 1.5 ft stand at y 24 sits in the gap
  assert.ok(24 > 6 + 14 && 24 + 1.5 < 34);
});

/* ---------------- 2. logo upload end to end ---------------- */
// a mocked ugPrepareImage (the real source) with a fake canvas: webp = whether the browser can encode WebP
function prepare(webp, pngBytes) {
  const src = fnSrc(sa, 'ugPrepareImage').replace(/^function/, 'async function');
  const UG = sa.match(/const UG_SNIFF = \[[\s\S]*?\n  \];/)[0];
  const MAGIC = { 'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 'image/jpeg': [0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1],
    'image/webp': [0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20] };
  const log = { fills: 0, types: [] };
  const mkBlob = (type, size) => { const bytes = new Uint8Array(Math.max(16, size)); bytes.set(MAGIC[type]); const bl = new Blob([bytes], { type }); return bl; };
  const canvas = () => { const c = { width: 0, height: 0,
    getContext: () => ({ fillRect: () => { log.fills++; }, drawImage() {}, set fillStyle(v) {}, set imageSmoothingEnabled(v) {}, set imageSmoothingQuality(v) {} }),
    toBlob: (cb, type) => { log.types.push(type); const real = type === 'image/webp' && !webp ? 'image/png' : type; cb(mkBlob(real, real === 'image/png' ? (pngBytes || 4000) : 3000)); } }; return c; };
  const global = { document: { createElement: () => canvas() }, createImageBitmap: async () => ({ width: 400, height: 200, close() {} }) };
  const f = new Function('global', 'URL', `${UG}
    function ugErr(msg, code) { const e = new Error(msg); e.code = code || 'upload_invalid'; return e; }
    function ugSniff(bytes) { const b = bytes || []; if (b.length < 12) return null; for (const [mime, ext, ok] of UG_SNIFF) { if (ok(b)) return { mime, ext }; } return null; }
    async function ugHead(file, n) { return new Uint8Array(await file.slice(0, n || 16).arrayBuffer()); }
    function ugMismatch() { return null; }
    function ugFit(w, h, maxPx) { const k = Math.min(1, (maxPx || 2560) / Math.max(w, h)); return { w: Math.round(w * k), h: Math.round(h * k) }; }
    ${src}; return ugPrepareImage;`)(global, URL);
  return { run: (opts) => f(mkBlob('image/png', 5000), Object.assign({ maxBytes: 8 * 1024 * 1024 }, opts)), log };
}

t('transparent logo: keepAlpha uploads WebP-with-alpha (or PNG on Safari), never a white box; photos still flatten', async () => {
  let p = prepare(true); let r = await p.run({ keepAlpha: true });
  assert.equal(r.mime, 'image/webp'); assert.equal(p.log.fills, 0, 'no white fill under a logo');
  p = prepare(false); r = await p.run({ keepAlpha: true });
  assert.deepEqual([r.mime, r.ext], ['image/png', 'png'], 'Safari (no WebP encoder): lossless PNG keeps transparency'); assert.equal(p.log.fills, 0);
  p = prepare(false, 9 * 1024 * 1024); r = await p.run({ keepAlpha: true });
  assert.equal(r.mime, 'image/jpeg', 'PNG too big: JPEG last resort'); assert.ok(p.log.fills >= 1, '... on a white-backed copy');
  p = prepare(false); r = await p.run({});
  assert.equal(r.mime, 'image/jpeg', 'invitation photos: unchanged (WebP else JPEG)'); assert.ok(p.log.fills >= 1, 'photos still flatten on white');
  p = prepare(true); r = await p.run({}); assert.equal(r.mime, 'image/webp'); assert.ok(p.log.fills >= 1);
  // wiring: builder asks for it, uploadPhoto passes it through; PNG keys are allowed by the bucket + storage_key_ok + cleanLogo
  assert.match(fnSrc(b, 'screenLogoAdd'), /uploadPhoto\(currentQuoteId, up, \{keepAlpha:true\}\)/);
  assert.match(sa, /async uploadPhoto\(quoteId, file, opts\) \{/);
  assert.match(sa, /maxPx: 2560, keepAlpha: !!\(opts && opts\.keepAlpha\) \}\)/);
  assert.equal(HS.cleanLogo('0b1f8e2a-1111-4c2d-9e0f-123456789abc/7d2c1e3f-2222-4a5b-8c6d-abcdef012345/9f8e7d6c-3333-4b2a-9c1d-0123456789ab.png').length > 0, true);
  assert.match(read('supabase/migrations/0027_uploads_payments.sql'), /\\\.\(png\|jpg\|webp\|gif\)\$/);
});

const PATH = '0b1f8e2a-1111-4c2d-9e0f-123456789abc/7d2c1e3f-2222-4a5b-8c6d-abcdef012345/9f8e7d6c-3333-4b2a-9c1d-0123456789ab.png';
t('signed link refresh: after 45 min a fresh link is fetched in the background; the old picture keeps showing; a failed refresh retries', async () => {
  assert.equal(HS.LOGO_REFRESH_MS, 45 * 60 * 1000);
  let clock = 1e12; const realNow = Date.now; Date.now = () => clock;
  const made = []; let failNext = false;
  globalThis.Image = class { constructor() { made.push(this); this.naturalWidth = 0; } set src(u) { this._s = u; setTimeout(() => { if (/fail/.test(u)) this.onerror(); else { this.naturalWidth = 100; this.naturalHeight = 50; this.onload(); } }, 0); } get src() { return this._s; } };
  let calls = 0;
  try {
    HS.forgetLogo(PATH);
    HS.setLogoResolver(async () => { calls++; return failNext ? 'https://abc.supabase.co/sign/fail.png' : 'https://abc.supabase.co/sign/v' + calls + '.png'; });
    HS.logoImage(PATH); await new Promise((r) => setTimeout(r, 10));
    assert.equal(HS.logoState(PATH), 'ok'); assert.match(HS.logoUrl(PATH), /v1\.png$/);
    clock += 10 * 60 * 1000; HS.logoImage(PATH); await new Promise((r) => setTimeout(r, 10)); assert.equal(calls, 1, 'fresh link: no re-sign');
    clock += 40 * 60 * 1000; const old = HS.logoImage(PATH); assert.ok(old, 'old picture returned while refreshing');
    await new Promise((r) => setTimeout(r, 10)); assert.equal(calls, 2); assert.match(HS.logoUrl(PATH), /v2\.png$/, '2D now uses the fresh link');
    clock += 46 * 60 * 1000; failNext = true; HS.logoImage(PATH); await new Promise((r) => setTimeout(r, 10));
    assert.equal(HS.logoState(PATH), 'ok', 'a failed refresh keeps the working picture'); assert.match(HS.logoUrl(PATH), /v2\.png$/);
    HS.logoImage(PATH); await new Promise((r) => setTimeout(r, 10)); assert.equal(calls, 3, 'no hammering right after a failure');
    clock += 61 * 1000; failNext = false; HS.logoImage(PATH); await new Promise((r) => setTimeout(r, 10)); assert.equal(calls, 4, 'retried a minute later');
    assert.ok(made.every((im) => im.crossOrigin === 'anonymous'));
  } finally { Date.now = realNow; delete globalThis.Image; HS.setLogoResolver(null); HS.forgetLogo(PATH); }
});

t('client-image capture waits for screen logos (max 6 s); whenLogos settles on ok / fail / no resolver', async () => {
  globalThis.Image = class { set src(u) { setTimeout(() => { this.naturalWidth = 10; this.onload(); }, 30); } };
  try {
    HS.forgetLogo(PATH); HS.setLogoResolver(async () => 'https://abc.supabase.co/sign/x.png');
    const st = await HS.whenLogos([PATH, PATH, 'nonsense', null], 2000);
    assert.deepEqual(st, ['ok'], 'deduped, junk refs dropped, waited for the load');
    HS.setLogoResolver(null); HS.forgetLogo(PATH);
    assert.deepEqual(await HS.whenLogos([PATH], 2000), ['none'], 'no resolver: nothing to wait for');
    HS.setLogoResolver(() => new Promise(() => {})); HS.forgetLogo(PATH);
    const t0 = Date.now(); assert.deepEqual(await HS.whenLogos([PATH], 150), ['loading']); assert.ok(Date.now() - t0 < 1000, 'time-boxed');
  } finally { delete globalThis.Image; HS.setLogoResolver(null); HS.forgetLogo(PATH); }
  const run = fnSrc(b, 'captureClientImagesRun');
  assert.ok(run.indexOf('await screenLogosReady()') >= 0 && run.indexOf('await screenLogosReady()') < run.indexOf("say('Capturing 2D…')"));
  assert.match(fnSrc(b, 'screenLogosReady'), /S\.contentOf\(it, store\.items\)\.logo/, 'mirrored side screens count too');
  assert.match(fnSrc(b, 'screenLogosReady'), /S\.whenLogos\(refs, 6000\)/);
});

t('exported 2D plan pictures keep the logo as pixels (data: PNG in the throw-away clone), never the signed link', () => {
  assert.equal(HS.logoSnapshot(PATH), '', 'nothing loaded: empty');
  const sym = fnSrc(b, 'screenLogo2D');
  assert.match(sym, /setAttribute\('crossorigin','anonymous'\)/); assert.match(sym, /setAttribute\('data-logo', sc\.logo\)/);
  const pb = fnSrc(b, 'planBlob');
  assert.match(pb, /HelmScreen\.logoSnapshot\(n\.getAttribute\('data-logo'\)\)/);
  assert.match(pb, /n\.removeAttribute\('data-logo'\); n\.removeAttribute\('crossorigin'\); if\(d\) n\.setAttribute\('href', d\); else n\.remove\(\);/);
  const ss = read('public/stage-screen.js'), snap = fnSrc(ss, 'logoSnapshot');
  assert.match(snap, /toDataURL\('image\/png'\)/); assert.match(snap, /catch \(err\) \{ return ''; \}/, 'a tainted canvas never throws');
  // the stored layout still only ever holds the storage path (never a data: URL)
  assert.equal(HS.cleanLogo('data:image/png;base64,AAAA'), '');
  // with a fake DOM: a loaded picture becomes a PNG data URL, shrunk to <= 512 px
  const drawn = [];
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage: (im, x, y, w, h) => drawn.push([w, h]) }), toDataURL: () => 'data:image/png;base64,iVBORw0KGgo=' }) };
  globalThis.Image = class { set src(u) { this.naturalWidth = 2048; this.naturalHeight = 1024; setTimeout(() => this.onload(), 0); } };
  return (async () => {
    try {
      HS.forgetLogo(PATH); HS.setLogoResolver(async () => 'https://abc.supabase.co/sign/x.png');
      await HS.whenLogos([PATH], 1000);
      assert.equal(HS.logoSnapshot(PATH), 'data:image/png;base64,iVBORw0KGgo='); assert.deepEqual(drawn[0], [512, 256]);
    } finally { delete globalThis.document; delete globalThis.Image; HS.setLogoResolver(null); HS.forgetLogo(PATH); }
  })();
});

t('CSP: the builder + capture pages allow Supabase storage images and blob:/data: (3D textures, exports) under Trusted Types', () => {
  const v = JSON.parse(read('vercel.json'));
  const csp = (src) => { const h = v.headers.find((x) => x.source === src && !x.has); return h.headers.find((k) => k.key === 'Content-Security-Policy').value; };
  for (const src of v.headers.filter((h) => !h.has && /builder|capture/.test(h.source) && h.headers.some((k) => k.key === 'Content-Security-Policy')).map((h) => h.source)) {
    const img = csp(src).split(';').map((d) => d.trim()).find((d) => d.startsWith('img-src '));
    assert.match(img, /'self' data: blob: https:\/\/[a-z]+\.supabase\.co/, src + ' img-src');
    assert.match(csp(src), /connect-src[^;]*https:\/\/[a-z]+\.supabase\.co/, src + ' connect-src (signing)');
    assert.match(csp(src), /require-trusted-types-for 'script'/);
  }
});

for (const [name, fn] of tests) { await fn(); n++; console.log('  ✓ ' + name); }
console.log('r154-jyothi-logo: ' + n + ' checks passed');
