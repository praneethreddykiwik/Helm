// R137: stage screen layout (single / triple / wide / none), logo picture, screen colour, richer themes (+3 new),
// and stylised dancers in 3D. Old layouts must look exactly as before.
import { readFileSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const b = read('public/builder.js'), b3 = read('public/builder-3d.js'), ss = read('public/stage-screen.js'), dsrc = read('public/dancers-3d.js');
const HS = require('../public/stage-screen.js');
const HD = require('../public/dancers-3d.js');
const P = require('../public/photo-render-prompt.js');
let n = 0; const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const fnSrc = (src, name) => { const i = src.indexOf('function ' + name + '('); assert.ok(i >= 0, name); let d = 0, j = src.indexOf('{', i);
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}' && --d === 0) break; } return src.slice(i, j + 1); };
const PATH = '0b1f8e2a-1111-4c2d-9e0f-123456789abc/7d2c1e3f-2222-4a5b-8c6d-abcdef012345/9f8e7d6c-3333-4b2a-9c1d-0123456789ab.png';
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52];
const JPG = [0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1];
const WEBP = [0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20];
const GIF = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0];
const SVG = [...Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')];

/* ---- 1. screen layout ---- */
t('screen layouts: Standard (as before) / Single / Triple / Wide LED wall / None; unknown values dropped', () => {
  assert.deepEqual(HS.LAYOUTS.map((l) => l[0]), ['', 'single', 'triple', 'wide', 'none']);
  const p = HS.sanitize({ screenLayout: 'bogus' }); assert.equal(p.screenLayout, undefined);
  assert.equal(HS.sanitize({ screenLayout: 'wide' }).screenLayout, 'wide');
  assert.equal(HS.sanitize({ screenLayout: '__proto__' }).screenLayout, undefined);
  assert.equal(HS.stageSegments('none', 40).length, 0);
  assert.equal(HS.stageSegments('single', 40).length, 1);
  assert.equal(HS.stageSegments('wide', 40).length, 1); assert.ok(HS.stageSegments('wide', 40)[0].w >= 0.85, 'wall spans the backdrop');
  const tri = HS.stageSegments('triple', 40); assert.equal(tri.length, 3); assert.equal(tri.filter((s) => s.side).length, 2);
});

t('default is unchanged: an old stage keeps the single blue screen; a themed old stage keeps centre + two side panels at the R135 sizes', () => {
  const old = HS.contentOf({ type: 'stage', properties: {} }, []);
  assert.equal(HS.hasContent(old), false); assert.equal(HS.layoutOf(old), 'legacy');
  assert.deepEqual(HS.stageSegments('legacy', 40), [{ x: 0, w: 0.42, y: 0.6, h: 0.45, side: false, slot: '' }]);
  const themed = HS.contentOf({ type: 'stage', properties: { screenTheme: 'royal', brand: 'CRISKA' } }, []);
  assert.equal(HS.layoutOf(themed), 'triple');
  const w = 40, bh = 12, seg = HS.stageSegments('triple', w);
  // exactly the R135 numbers: centre w*0.42 x bh*0.45 at H+bh*0.6; sides max(1.5, w*0.1) x bh*0.62 at +-w*0.34, H+bh*0.52
  assert.deepEqual([seg[0].w * w, seg[0].h * bh, seg[0].y], [w * 0.42, bh * 0.45, 0.6]);
  for (const s of seg.slice(1)) { assert.ok(Math.abs(s.w * w - Math.max(1.5, w * 0.1)) < 1e-9); assert.equal(s.h * bh, bh * 0.62); assert.equal(Math.abs(s.x), 0.34); assert.equal(s.y, 0.52); }
  // 3D: no content -> the original blue box; layout None -> no screen; otherwise one face per segment
  assert.match(b3, /\} else \{\n\s+const scr=boxMesh\(w\*0\.42,bh\*0\.45,0\.15,'#2f6fed'/);
  assert.match(b3, /if\(lay==='none'\)\{ \/\* R137: screen layout None/);
  assert.match(b3, /HSx\.stageSegments\(HSx\.layoutOf\(sc\), w\)\.forEach\(sg=>/);
  // 2D: '' keeps the R135 full-width band; an explicit layout draws its screen segments on the band
  const band = fnSrc(b, 'screenBand2D');
  assert.match(band, /if\(!lay\)\{   \/\/ R135 look/); assert.match(band, /HelmScreen\.stageSegments\(lay, it\.width\)\.forEach/);
  assert.match(b, /if\(sc && sc\.layout==='none'\)/);
  // side screens never take a layout (stage only) and mirrored screens copy theme / colour / logo, not the layout
  assert.equal(HS.contentOf({ type: 'ledscreen', properties: { screenLayout: 'wide' } }, []).layout, '');
  const st = { type: 'stage', properties: { screenLayout: 'single', screenBg: '#123456', screenLogo: 'studio' } };
  const m = HS.contentOf({ type: 'sidescreen', properties: { screenMirror: true } }, [st]);
  assert.equal(m.layout, ''); assert.equal(m.bg, '#123456'); assert.equal(m.logo, 'studio');
  assert.equal(HS.hasContent(HS.rawContent({ screenLayout: 'none' })), false, 'None alone = no screen content');
});

/* ---- 2. logo ---- */
t('logo validation: PNG / JPG / WebP by magic bytes only, <= 2 MB; SVG, GIF, fakes and empty files refused', () => {
  const f = (size, type, name) => ({ size, type, name });
  assert.deepEqual(HS.validateLogo(f(1000, 'image/png', 'a.png'), PNG), { ok: true, mime: 'image/png', ext: 'png' });
  assert.equal(HS.validateLogo(f(1000, '', 'x'), JPG).ext, 'jpg');
  assert.equal(HS.validateLogo(f(1000, 'image/webp', 'x.webp'), WEBP).ext, 'webp');
  assert.equal(HS.validateLogo(f(1000, 'image/svg+xml', 'logo.svg'), SVG).ok, false);
  assert.match(HS.validateLogo(f(1000, 'image/png', 'logo.svg'), PNG).reason, /SVG/);
  assert.equal(HS.validateLogo(f(1000, 'image/png', 'logo.png'), SVG).ok, false, 'SVG renamed to .png: bytes decide');
  assert.equal(HS.validateLogo(f(1000, 'image/gif', 'a.gif'), GIF).ok, false);
  assert.equal(HS.validateLogo(f(1000, 'image/png', 'a.png'), [0x89, 0x50, 0x4e]).ok, false, 'truncated header');
  assert.match(HS.validateLogo(f(2 * 1024 * 1024 + 1, 'image/png', 'a.png'), PNG).reason, /2 MB/);
  assert.equal(HS.validateLogo(f(2 * 1024 * 1024, 'image/png', 'a.png'), PNG).ok, true);
  assert.equal(HS.validateLogo(f(0, 'image/png', 'a.png'), PNG).ok, false);
  assert.equal(HS.validateLogo(null, PNG).ok, false);
  // downscale before upload: longest side <= 512, never enlarged, aspect kept
  assert.deepEqual(HS.fitLogoSize(2048, 1024), { w: 512, h: 256 }); assert.deepEqual(HS.fitLogoSize(300, 120), { w: 300, h: 120 });
  assert.deepEqual(HS.fitLogoSize(600, 3000), { w: 102, h: 512 });
});

t('only a storage reference is ever kept: the invite-media path or "studio" - never a data: URL, a web link or a GIF', () => {
  assert.equal(HS.cleanLogo(PATH), PATH); assert.equal(HS.cleanLogo('studio'), 'studio');
  for (const bad of ['data:image/png;base64,iVBORw0KGgo=', 'https://evil.example/x.png', '../../etc/passwd', PATH.replace('.png', '.gif'),
    PATH.replace('.png', '.svg'), PATH.toUpperCase(), PATH + '?x=1', 'javascript:alert(1)', 42, null, { path: PATH }]) assert.equal(HS.cleanLogo(bad), '', String(bad));
  const p = HS.sanitize({ screenLogo: 'data:image/png;base64,AAAA', brand: 'X' }); assert.equal(p.screenLogo, undefined);
  assert.equal(HS.sanitize({ screenLogo: PATH }).screenLogo, PATH);
  // the builder stores the PATH it gets back from the Invite Studio uploader (same bucket, key and per-studio rules)
  const add = fnSrc(b, 'screenLogoAdd');
  assert.match(add, /BPStore\.sites\.uploadPhoto\(currentQuoteId, up, \{keepAlpha:true\}\)/);   // R154: keeps transparency
  assert.match(add, /it\.properties\.screenLogo=path;/);
  assert.ok(!/data:|toDataURL|readAsDataURL/.test(add + fnSrc(b, 'shrinkLogo') + fnSrc(b, 'screenExtrasMount')), 'no data: URL anywhere in the logo flow');
  assert.match(fnSrc(b, 'shrinkLogo'), /S\.fitLogoSize\(w,h,S\.LOGO_MAX_PX\)/);
  assert.match(fnSrc(b, 'shrinkLogo'), /cv\.toBlob\(ok,'image\/png'\)/);
  const lp = new Function('window', 'HelmScreen', fnSrc(b, 'logoPathFromUrl') + '; return logoPathFromUrl;')({ HelmScreen: HS }, HS);
  assert.equal(lp('https://x.supabase.co/storage/v1/object/public/invite-media/' + PATH), PATH);
  assert.equal(lp('https://x.supabase.co/storage/v1/object/public/invite-media/' + PATH.replace('.png', '.gif')), '');
  assert.equal(lp('https://x.supabase.co/storage/v1/object/public/chat-media/' + PATH), '');
  // header bytes are sniffed before anything is uploaded
  assert.ok(add.indexOf('S.validateLogo(file, head)') < add.indexOf('uploadPhoto'), 'validate first');
  assert.ok(add.indexOf('screenLogoGate()') < add.indexOf('validateLogo'), 'trial / sign-in gate first');
});

t('logo display: signed link via mediaUrls, crossOrigin anonymous, failure -> monogram; studio logo only from Helm storage', async () => {
  assert.match(b, /BPStore\.sites\.mediaUrls\(\['\/storage\/v1\/object\/public\/invite-media\/'\+ref\], 3600\)/);
  assert.match(ss, /img\.crossOrigin = 'anonymous'/);
  const ok = new Function('window', fnSrc(b, 'supabaseOrigin') + fnSrc(b, 'studioLogoOk') + '; return studioLogoOk;')({ SUPABASE_CONFIG: { url: 'https://abc.supabase.co' } });
  assert.equal(ok('https://abc.supabase.co/storage/v1/object/public/brand/logo.png'), true);
  assert.equal(ok('https://elsewhere.example/logo.png'), false); assert.equal(ok('http://abc.supabase.co/x.png'), false); assert.equal(ok(null), false);
  // mocked loader: loads, fails, bad URL
  const made = [];
  globalThis.Image = class { constructor() { made.push(this); this.naturalWidth = 0; } set src(u) { this._s = u; setTimeout(() => { if (/fail/.test(u)) this.onerror(); else { this.naturalWidth = 200; this.naturalHeight = 100; this.onload(); } }, 0); } get src() { return this._s; } };
  try {
    const seen = []; HS.onLogoChange((ref, st) => seen.push(ref + ':' + st));
    const P2 = PATH.replace('9f8e7d6c', '8f8e7d6c'), P3 = PATH.replace('9f8e7d6c', '7f8e7d6c');
    HS.setLogoResolver(async (ref) => ref === PATH ? 'https://abc.supabase.co/sign/ok.png' : ref === P2 ? 'https://abc.supabase.co/sign/fail.png' : 'javascript:alert(1)');
    assert.equal(HS.logoImage(PATH), null, 'not loaded yet'); assert.equal(HS.logoState(PATH), 'loading');
    HS.logoImage(P2); HS.logoImage(P3);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(HS.logoState(PATH), 'ok'); assert.equal(HS.logoState(P2), 'fail'); assert.equal(HS.logoState(P3), 'fail', 'non-https URL refused');
    assert.ok(made.every((im) => im.crossOrigin === 'anonymous'));
    assert.equal(made.length, 2, 'no image for the refused URL');
    assert.deepEqual(seen.sort(), [P2 + ':fail', P3 + ':fail', PATH + ':ok'].sort());
    // texture key changes once the picture arrives (3D redraws)
    const c = HS.rawContent({ brand: 'CRISKA', screenLogo: PATH }); assert.match(HS.keyOf(c, false, 1024, 512), /:ok/);
    // drawing: a loaded logo replaces the monogram; no logo / a failed one keeps the letter
    const drawn = [], imgs = [];
    const ctx = new Proxy({ fillText: (s) => drawn.push(s), drawImage: (im) => imgs.push(im), measureText: (s) => ({ width: s.length * 10 }) }, { get: (o, k) => (k in o ? o[k] : () => {}), set: () => true });
    HS.draw(ctx, 1024, 512, c, { logo: HS.logoImage(PATH) }); assert.equal(imgs.length, 1); assert.ok(!drawn.includes('C'), 'logo replaces the letter'); assert.ok(drawn.includes('CRISKA'));
    drawn.length = 0; imgs.length = 0; HS.draw(ctx, 384, 1024, c, { side: true, logo: HS.logoImage(PATH) }); assert.equal(imgs.length, 1, 'side panels too');
    drawn.length = 0; imgs.length = 0; HS.draw(ctx, 1024, 512, HS.rawContent({ brand: 'CRISKA', screenLogo: P2 }), { logo: HS.logoImage(P2) });
    assert.equal(imgs.length, 0); assert.ok(drawn.includes('C'), 'failed logo -> monogram');
    drawn.length = 0; HS.draw(ctx, 1024, 512, HS.rawContent({ brand: 'CRISKA' }), { logo: HS.logoImage(PATH) }); assert.ok(drawn.includes('C'), 'no logo set -> monogram even if an image is passed');
    // 3D passes the logo image into the texture and the logo state into its cache key
    assert.match(b3, /const logo=c\.logo && HS\.logoImage \? HS\.logoImage\(c\.logo\) : null;/);
    assert.match(b3, /HS\.draw\(x, W, H, c, \{ side, logo \}\)/);
    assert.match(b, /HelmScreen\.onLogoChange\(\(\)=>\{ try\{ renderSceneOnly\(\); if\(window\.__on3DStateChange\) window\.__on3DStateChange\(\);/);
    // exported pictures never carry the signed link
    // R154: the export bakes the logo PIXELS (HelmScreen.logoSnapshot) and drops the signed href + marker; no picture = removed
    assert.match(b, /clone\.querySelectorAll\('\.scr-logo'\)\.forEach\(n=>\{ const d=window\.HelmScreen && HelmScreen\.logoSnapshot \? HelmScreen\.logoSnapshot\(n\.getAttribute\('data-logo'\)\) : '';/);
    assert.match(b, /n\.removeAttribute\('data-logo'\); n\.removeAttribute\('crossorigin'\); if\(d\) n\.setAttribute\('href', d\); else n\.remove\(\); \}\);/);
  } finally { delete globalThis.Image; HS.setLogoResolver(null); }
});

/* ---- 3. colour ---- */
t('screen colour: #rrggbb only; text colour auto-picked for >= 4.5:1 contrast; Reset to theme', () => {
  assert.equal(HS.cleanHex('#AABBCC'), '#aabbcc'); for (const bad of ['red', '#abc', '#12345g', 'url(x)', '#1234567', 7]) assert.equal(HS.cleanHex(bad), '', String(bad));
  assert.equal(HS.sanitize({ screenBg: 'red' }).screenBg, undefined); assert.equal(HS.sanitize({ screenBg: '#FFB703' }).screenBg, '#ffb703');
  assert.ok(Math.abs(HS.contrast('#ffffff', '#000000') - 21) < 1e-9); assert.ok(Math.abs(HS.contrast('#777777', '#777777') - 1) < 1e-9);
  assert.equal(HS.inkFor('#ffffff'), '#111111'); assert.equal(HS.inkFor('#000000'), '#ffffff'); assert.equal(HS.inkFor('#0b2a5b', '#f8e7b0'), '#f8e7b0', 'theme ink kept when it reads');
  const colours = [...HS.BG_SWATCHES]; for (let i = 0; i < 300; i++) colours.push('#' + ((i * 2654435761) >>> 8 & 0xffffff).toString(16).padStart(6, '0'));
  for (const th of HS.THEME_ORDER) for (const bg of colours) {
    const pal = HS.paletteOf(HS.rawContent({ screenTheme: th, screenBg: bg }));
    assert.equal(pal.bg, bg); assert.ok(HS.contrast(bg, pal.ink) >= 4.5, th + ' ' + bg + ' ink ' + pal.ink); assert.ok(HS.contrast(bg, pal.sub) >= 4.5, th + ' ' + bg + ' sub');
  }
  assert.equal(HS.paletteOf(HS.rawContent({ screenTheme: 'royal' })), HS.THEMES.royal, 'no colour = the theme');
  const ui = fnSrc(b, 'screenExtrasMount');
  assert.match(ui, /ci\.type='color'/); assert.match(ui, /btn\('Reset to theme'\)/); assert.match(ui, /delete P\(\)\.screenBg/); assert.match(ui, /S\.BG_SWATCHES\.forEach/);
  assert.match(ui, /const h=S\.cleanHex\(v\); if\(!h \|\| RO\) return;/, 'validated before it is stored');
});

/* ---- 4. themes ---- */
t('themes: the 6 R135 names still valid + Festive Marigold, Elegant Black-Gold, Tech Gradient; every theme draws, readable', () => {
  for (const k of ['corporate', 'royal', 'floral', 'minimal', 'neon']) { assert.ok(HS.THEMES[k]); assert.equal(HS.sanitize({ screenTheme: k }).screenTheme, k); }
  assert.deepEqual(HS.THEME_ORDER.slice(6), ['marigold', 'blackgold', 'tech']);
  assert.deepEqual(HS.THEME_ORDER.slice(6).map((k) => HS.THEMES[k].name), ['Festive Marigold', 'Elegant Black-Gold', 'Tech Gradient']);
  for (const k of HS.THEME_ORDER) { const T = HS.THEMES[k]; assert.ok(/^#[0-9a-f]{6}$/.test(T.bg) && /^#[0-9a-f]{6}$/.test(T.bg2) && /^#[0-9a-f]{6}$/.test(T.ink), k);
    if (k) assert.ok(HS.contrast(T.bg, T.ink) >= 4.5, k + ' title colour readable'); }
  const calls = {}, drawn = [];
  const ctx = new Proxy({ fillText: (s) => drawn.push(s), measureText: (s) => ({ width: s.length * 10 }), createLinearGradient: () => ({ addColorStop() {} }), createRadialGradient: () => ({ addColorStop() {} }) },
    { get: (o, k) => (k in o ? o[k] : (...a) => { calls[k] = (calls[k] || 0) + 1; }), set: (o, k, v) => { calls['set:' + k] = v; return true; } });
  for (const th of HS.THEME_ORDER) { drawn.length = 0; HS.draw(ctx, 1024, 512, HS.rawContent({ screenTheme: th, brand: 'CRISKA', title: 'Annual Day' }));
    assert.ok(drawn.includes('Annual Day') && drawn.includes('C'), th); }
  assert.ok(calls.bezierCurveTo > 10 && calls.quadraticCurveTo > 10, 'canvas paths (waves, filigree, florals)');
  assert.ok(calls['set:shadowBlur'] !== undefined, 'neon glow uses shadowBlur');
  // a minimal context without gradients still draws (flat colour fallback)
  HS.draw(new Proxy({ fillText() {}, measureText: () => ({ width: 1 }) }, { get: (o, k) => (k in o ? o[k] : () => {}), set: () => true }), 512, 256, HS.rawContent({ screenTheme: 'tech', screenBg: '#ffffff' }));
  assert.ok(!/innerHTML|insertAdjacentHTML|eval\(|new Function|fetch\(|XMLHttpRequest/.test(ss), 'no HTML sinks / network in the screen model');
  assert.match(b3, /Math\.min\(1024, Math\.round\(1024\*asp\)\)/, 'texture size capped at 1024');
});

/* ---- 5. dancers ---- */
t('dancers: dance style option, old layouts unchanged in shape (same item, new optional props), 2D figure icons', () => {
  const vx = new Function('return ' + b.slice(b.indexOf('const VARIANT_EXTRA = {') + 'const VARIANT_EXTRA = '.length, b.indexOf('\n};', b.indexOf('const VARIANT_EXTRA = {')) + 2))();
  assert.deepEqual(vx.dancers[0][2].map((o) => o[0]), ['', 'classical', 'western']);
  assert.equal(HD.styleOf({ properties: {} }), ''); assert.equal(HD.styleOf({ properties: { danceStyle: 'western' } }), 'western'); assert.equal(HD.styleOf({ properties: { danceStyle: '__proto__' } }), '');
  assert.equal(HD.countOf({ width: 12, height: 8, properties: {} }), 6, 'old layout: from the zone size as before');
  assert.equal(HD.countOf({ width: 12, height: 8, properties: { count: 20 } }), 8); assert.equal(HD.countOf({ width: 12, height: 8, properties: { count: 2 } }), 2);
  assert.match(b, /if\(P\.danceStyle!=null && \['classical','western'\]\.indexOf\(P\.danceStyle\)<0\) delete P\.danceStyle;/);
  const d2 = b.slice(b.indexOf("    case 'dancers': { drawBox"), b.indexOf("    case 'generator':"));
  assert.match(d2, /small dancer figures/); assert.ok((d2.match(/el\('path'/g) || []).length >= 2 && /el\('circle'/.test(d2));
  assert.match(b3, /const HD=typeof window!=='undefined' && window\.HelmDancers;\n\s+if\(HD && typeof HD\.build==='function'\)\{ try\{ if\(HD\.build\(THREE, g, it\)\) break; \}catch\(_\)\{\} \}/);
  for (const f of ['public/builder.html', 'public/try.html', 'public/capture.html'])
  { const h = read(f), i = h.indexOf('<script src="dancers-3d.js?v='); assert.ok(i > 0 && i < h.indexOf('<script src="builder-3d.js?v='), f + ': dancers-3d.js before builder-3d.js'); }
  assert.ok(!/innerHTML|document\.|fetch\(/.test(dsrc), 'pure 3D builder');
  const pr = P.build({ items: [{ id: 'd', type: 'dancers', x: 50, y: 50, width: 12, height: 8, rotation: 0, properties: { danceStyle: 'classical' } }], world: { w: 200, h: 140 } }).prompt;
  assert.match(pr, /Indian classical dance/);
});

t('dancers 3D (real three.js): people from primitives, every style + count builds, shared shapes, <= 400 triangles a dancer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'r137-three-'));
  try {
    copyFileSync(new URL('../public/vendor/three-0.186.1/three.module.min.js', import.meta.url), join(dir, 'three.mjs'));
    const T = await import(pathToFileURL(join(dir, 'three.mjs')).href); const THREE = { ...T };
    let kitGeo = null;
    for (const st of ['', 'classical', 'western']) for (const count of [undefined, 1, 4, 8]) for (const size of [[12, 8], [4, 3], [30, 20]]) {
      const g = new THREE.Group(), props = { danceStyle: st }; if (count) props.count = count;
      const it = { id: 'dz-' + st + count, type: 'dancers', width: size[0], height: size[1], color: '#7c3aed', properties: props };
      assert.equal(HD.build(THREE, g, it), true);
      const nD = g.userData.dancerCount; assert.equal(nD, HD.countOf(it));
      assert.equal(g.children.length, nD + 1, 'floor mark + one group per dancer');
      assert.ok(g.userData.dancerTriangles / nD <= 400, st + ' ' + (g.userData.dancerTriangles / nD) + ' triangles');
      g.children.slice(1).forEach((fig) => { assert.ok(fig.children.length >= 3, 'skin / costume / hair parts');
        const box = new THREE.Box3().setFromObject(fig); assert.ok(box.min.y > -0.05 && box.min.y < 0.2, 'standing on the floor ' + box.min.y);
        assert.ok(box.max.y > 4.2 && box.max.y < 9, 'human height (ft) ' + box.max.y); });
      // the floor mark is a faint tint, not the old solid purple slab
      assert.ok(g.children[0].material.opacity <= 0.15);
      const fig = g.children[1]; const geo = fig.children[0].geometry; assert.ok(geo.attributes.position.count > 0);
      if (!kitGeo) kitGeo = true;
    }
    // costume colours vary between dancers; the lead uses the item colour
    const g = new THREE.Group(); HD.build(THREE, g, { id: 'mix', type: 'dancers', width: 16, height: 8, color: '#0ea5e9', properties: { count: 6 } });
    const colours = new Set(); g.children.slice(1).forEach((f) => f.children.forEach((m) => colours.add(m.material.color.getHexString())));
    assert.ok(colours.size >= 5, 'varied costume colours + skin tones');
    assert.ok(colours.has('0ea5e9') || [...colours].some((c) => c.startsWith('0e')), 'lead costume = item colour');
    // shared materials between rebuilds (no per-build material churn)
    const g2 = new THREE.Group(); HD.build(THREE, g2, { id: 'mix', type: 'dancers', width: 16, height: 8, color: '#0ea5e9', properties: { count: 6 } });
    assert.equal(g.children[1].children[0].material, g2.children[1].children[0].material);
    // no THREE -> false (builder-3d falls back to the old figures)
    assert.equal(HD.build(null, g, { type: 'dancers' }), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/* ---- 6. trial + sign-in gate ---- */
t('free trial: no logo upload (friendly message, monogram stays); signed-out / no event / read-only explained', () => {
  const gate = (o) => new Function('RO', 'builderInTrial', 'window', 'BPStore', 'currentQuoteId', 'SCREEN_LOGO_TRIAL_MSG',
    fnSrc(b, 'screenLogoGate') + '; return screenLogoGate();')(o.RO || false, () => !!o.trial, o.win, o.store, o.quote || null, 'TRIAL');
  const store = { mode: () => 'supabase', sites: { uploadPhoto() {} } };
  assert.equal(gate({ trial: true, win: { BPStore: store }, store, quote: 'q1' }), 'TRIAL');
  assert.match(gate({ win: {}, store: undefined, quote: 'q1' }), /Sign in/);
  assert.match(gate({ win: { BPStore: { mode: () => 'local' } }, store: { mode: () => 'local' }, quote: 'q1' }), /Sign in/);
  assert.match(gate({ win: { BPStore: store }, store }), /from an event/);
  assert.match(gate({ RO: true, win: { BPStore: store }, store, quote: 'q1' }), /read-only/);
  assert.equal(gate({ win: { BPStore: store }, store, quote: 'q1' }), '');
  assert.match(b, /const SCREEN_LOGO_TRIAL_MSG='Logo pictures unlock on a paid plan\. The screen keeps the brand letter for now\.';/);
  assert.match(fnSrc(b, 'screenLogoAdd'), /const gate=screenLogoGate\(\); if\(gate\)\{ say\(gate\); return false; \}/);
  assert.match(fnSrc(b, 'screenLogoError'), /trial_locked/);
  // add button asks the gate before opening the file picker; the trial message is shown up front
  const ui = fnSrc(b, 'screenExtrasMount');
  assert.match(ui, /add\.addEventListener\('click',\(\)=>\{ if\(RO\) return; const g=screenLogoGate\(\); if\(g\)\{ say\(g\); return; \} fi\.click\(\); \}\);/);
  assert.match(ui, /fi\.accept='image\/png,image\/jpeg,image\/webp'/);
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(ui + fnSrc(b, 'screenBand2D') + fnSrc(b, 'screenLogo2D')), 'DOM API only');
});

/* ---- 7. photo render prompt ---- */
t('photo-render prompt names the screen layout, the colour and "custom logo shown" (never the storage path)', () => {
  const items = [{ id: 's1', type: 'stage', x: 80, y: 2, width: 40, height: 16, rotation: 0, properties: { screenLayout: 'wide', screenBg: '#0B2A5B', screenLogo: PATH, brand: 'CRISKA', screenTheme: 'blackgold' } }];
  const pr = P.build({ items, world: { w: 200, h: 140 } }).prompt;
  assert.match(pr, /one full-width LED wall across the whole backdrop/); assert.match(pr, /#0b2a5b background colour/);
  assert.match(pr, /custom logo shown in place of a letter monogram/); assert.match(pr, /black and gold art-deco/);
  assert.ok(!pr.includes(PATH) && !pr.includes('invite-media'), 'no storage path in the prompt');
  const none = P.build({ items: [{ ...items[0], properties: { screenLayout: 'none' } }], world: { w: 200, h: 140 } }).prompt;
  assert.match(none, /a plain backdrop with no screen/);
  const old = P.build({ items: [{ ...items[0], properties: {} }], world: { w: 200, h: 140 } }).prompt;
  assert.ok(!/LED wall|custom logo|background colour/.test(old), 'old stage: prompt unchanged');
});

for (const [name, fn] of tests) { await fn(); n++; console.log('  ✓ ' + name); }
console.log('r137-stage-screen-logo-dancers: ' + n + ' checks passed');
