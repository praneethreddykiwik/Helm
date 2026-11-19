// R200: picture screens (Text OR Picture, real size + recommended pixels, shape check, Fit / Fill), the
// "3 screens (centre + 2 sides)" preset, and the Welcome Board (sizes, picture or a ready design) in 2D + 3D.
// Old layouts carry none of the new keys and must look exactly as before.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const b = read('public/builder.js'), b3 = read('public/builder-3d.js'), css = read('public/builder.css'), html = read('public/builder.html'), pru = read('public/photo-render-ui.js');
const HS = require('../public/stage-screen.js');
const tests = []; const t = (name, fn) => tests.push([name, fn]);
const fnSrc = (src, name) => { const i = src.indexOf('function ' + name + '('); assert.ok(i >= 0, name); let d = 0, j = src.indexOf('{', i);
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}' && --d === 0) break; } return src.slice(i, j + 1); };
const PATH = '0b1f8e2a-1111-4c2d-9e0f-123456789abc/7d2c1e3f-2222-4a5b-8c6d-abcdef012345/9f8e7d6c-3333-4b2a-9c1d-0123456789ab.webp';
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52];
const JPG = [0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1];
const WEBP = [0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20];
const GIF = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0];
const SVG = [...Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')];
const near = (a, b2, eps = 1e-9) => Math.abs(a - b2) <= eps;

t('picture keys are cleaned: mode pic only, a storage path only (never studio / data: / a URL), Fit unless Fill', () => {
  const p = HS.sanitize({ screenMode: 'pic', screenPic: PATH, screenFit: 'cover', screenPicW: 1920, screenPicH: 1080 });
  assert.deepEqual([p.screenMode, p.screenPic, p.screenFit, p.screenPicW, p.screenPicH], ['pic', PATH, 'cover', 1920, 1080]);
  const bad = HS.sanitize({ screenMode: 'text', screenPic: 'studio', screenFit: 'stretch', screenPicW: '1920', screenPicH: -4 });
  for (const k of ['screenMode', 'screenPic', 'screenFit', 'screenPicW', 'screenPicH']) assert.equal(bad[k], undefined, k);
  for (const v of ['data:image/png;base64,AAAA', 'https://evil.example/x.png', '../' + PATH, PATH.replace('.webp', '.gif'), PATH.replace('.webp', '.svg')]) assert.equal(HS.sanitize({ screenPic: v }).screenPic, undefined, v);
  const s = HS.sanitize({ screenAspect: '16:9', screenH: 99, boardSize: '4x6', boardW: 0.2, boardH: '7' });
  assert.equal(s.screenAspect, '16:9'); assert.equal(s.screenH, 60, 'height capped'); assert.equal(s.boardSize, '4x6'); assert.equal(s.boardW, 1, 'board width floored'); assert.equal(s.boardH, 7);
  for (const v of ['17:9', '__proto__', 'constructor', '']) assert.equal(HS.sanitize({ screenAspect: v, boardSize: v }).screenAspect, undefined, v);
  assert.equal(HS.sanitize({ boardSize: '5x5' }).boardSize, undefined);
});

t('Text OR Picture: the picture shows only in picture mode; switching back to text keeps it; old layouts unchanged', () => {
  const pic = HS.rawContent({ screenMode: 'pic', screenPic: PATH, title: 'Annual Day' });
  assert.equal(pic.pic, PATH); assert.equal(pic.fit, 'contain', 'Fit is the default (nothing cut)'); assert.ok(HS.hasContent(pic));
  const txt = HS.rawContent({ screenPic: PATH, title: 'Annual Day' });
  assert.equal(txt.pic, '', 'text mode ignores the kept picture'); assert.equal(txt.title, 'Annual Day');
  assert.equal(HS.hasContent(HS.rawContent({})), false, 'an old screen has no content -> the old blue model');
  assert.equal(HS.contentOf({ type: 'welcomeboard', properties: {} }, []).board, true);
  assert.equal(HS.isScreenType('welcomeboard'), true);
  // a mirrored side screen shows the stage's picture
  const st = { type: 'stage', properties: { screenMode: 'pic', screenPic: PATH } };
  assert.equal(HS.contentOf({ type: 'sidescreen', properties: { screenMirror: true } }, [st]).pic, PATH);
  // the 3D texture key changes with the picture, its load state and the fit
  const k1 = HS.keyOf(pic, false, 1024, 576), k2 = HS.keyOf(Object.assign({}, pic, { fit: 'cover' }), false, 1024, 576);
  assert.notEqual(k1, k2); assert.notEqual(k1, HS.keyOf(txt, false, 1024, 576));
});

t('real size: Standard keeps every model exactly as before; a chosen shape sets the face (16:9 LED = 16 x 9 ft)', () => {
  const f = (type, w, h, props) => HS.faceOf({ type, width: w, height: h, properties: props || {} }, []);
  for (const w of [6, 12, 20, 33]) {
    assert.ok(near(f('ledscreen', w, 2).frame, Math.max(8, w * 0.4)), 'ledscreen ' + w);
    assert.ok(near(f('led', w, 2).frame, Math.max(6, Math.round(w * 9 / 16))), 'led ' + w);
    assert.ok(near(f('sidescreen', w, 1.5).frame, Math.max(9, Math.min(16, w * 1.8))), 'side ' + w);
    assert.ok(near(f('videowall', w, 10).frame, Math.max(8, 10)), 'videowall ' + w);
  }
  const led = f('ledscreen', 17, 2, { screenAspect: '16:9' }); assert.ok(near(led.w, 16) && near(led.h, 9) && near(led.frame, 10));
  const side = f('sidescreen', 6, 1.5, { screenAspect: '9:16' }); assert.ok(near(side.w / side.h, 9 / 16));
  const cus = f('videowall', 20, 8, { screenAspect: 'custom', screenH: 7.5 }); assert.ok(near(cus.h, 7.5) && near(cus.frame, 7.5 / 0.9));
  // stage: the centre screen of its layout; None = no screen
  const sg = f('stage', 40, 16, { screenLayout: 'single' }); assert.ok(near(sg.w, 40 * 0.56) && near(sg.h, Math.min(14, Math.max(8, 16 * 0.8)) * 0.52));
  assert.equal(f('stage', 40, 16, { screenLayout: 'none' }), null);
  // welcome board sizes (portrait)
  assert.deepEqual([f('welcomeboard', 3, 2.5, { boardSize: '2x3' }).w, f('welcomeboard', 3, 2.5, { boardSize: '2x3' }).h], [2, 3]);
  assert.deepEqual([f('welcomeboard', 3, 2.5, { boardSize: '4x6' }).w, f('welcomeboard', 3, 2.5, { boardSize: '4x6' }).h], [4, 6]);
  assert.deepEqual([f('welcomeboard', 3, 2.5, { boardSize: 'custom', boardW: 5, boardH: 7 }).w, f('welcomeboard', 3, 2.5, { boardSize: 'custom', boardW: 5, boardH: 7 }).h], [5, 7]);
  const old = HS.boardOf({ type: 'welcomeboard', width: 3, height: 2.5, properties: {} }); assert.equal(old.sized, false); assert.ok(near(old.w, 2.55) && near(old.h, 2.55 * 1.3), 'the R-old board size');
  assert.equal(HS.faceOf({ type: 'chiavari', width: 2, height: 2 }, []), null);
});

t('guidance in plain words: real size in ft + m, shape, and the picture size to make', () => {
  const g = HS.guidance({ type: 'ledscreen', width: 17, height: 2, properties: { screenAspect: '16:9' } }, []);
  assert.equal(g.size, '16 ft × 9 ft (4.9 × 2.7 m)'); assert.equal(g.ratio, '16:9'); assert.deepEqual([g.pxW, g.pxH], [1920, 1080]); assert.equal(g.print, false);
  const p = HS.guidance({ type: 'sidescreen', width: 6, height: 1.5, properties: { screenAspect: '9:16' } }, []);
  assert.deepEqual([p.ratio, p.pxW, p.pxH], ['9:16', 1080, 1920]);
  const bd = HS.guidance({ type: 'welcomeboard', width: 3, height: 2.5, properties: { boardSize: '2x3' } }, []);
  assert.deepEqual([bd.size, bd.ratio, bd.pxW, bd.pxH, bd.print], ['2 ft × 3 ft (0.6 × 0.9 m)', '2:3', 1600, 2400, true]);
  // other sizes are computed: 20 x 8 ft LED (old default face 19 x 7) -> long side 1920
  const o = HS.guidance({ type: 'ledscreen', width: 20, height: 2, properties: {} }, []);
  assert.equal(o.pxW, 1920); assert.equal(o.pxH, Math.round(1920 / (19 / 7))); assert.equal(o.ratio, '2.71:1');
  assert.equal(HS.ratioLabel(4, 3), '4:3'); assert.equal(HS.ratioLabel(21, 9), '21:9'); assert.equal(HS.ratioLabel(1, 2.5), '1:2.5');
  assert.deepEqual(HS.recommendPx(32, 9), { w: 1920, h: 540, ratio: '32:9' });
});

t('shape check: > 5% different warns (Fit / Fill offered); a matching picture does not', () => {
  assert.equal(HS.shapeDiff(1920, 1080, 16, 9), 0);
  assert.ok(HS.shapeDiff(1920, 1050, 16, 9) <= 5, 'within 5% is fine');
  assert.ok(HS.shapeDiff(1024, 1024, 16, 9) > 5); assert.ok(HS.shapeDiff(1080, 1920, 16, 9) > 5, 'portrait on a wide screen');
  assert.equal(HS.shapeDiff(0, 0, 16, 9), 0, 'unknown size -> no warning');
  const ui = fnSrc(b, 'screenPicturePanel');
  assert.match(ui, /if\(diff>5\)\{/); assert.match(ui, /screenPicPreview\(sec, ref, g, mk, pickFit, cur\)/); assert.match(ui, /select\('scr_fit','Picture fit',S\.FITS,cur,pickFit\)/);
  assert.deepEqual(HS.FITS.map((f) => f[0]), ['contain', 'cover']);
});

t('validation: bytes decide (PNG / JPG / WebP); SVG, GIF, not-a-picture and > 15 MB are refused in plain words', () => {
  const f = (size, type, name) => ({ size, type, name });
  for (const [bytes, mime] of [[PNG, 'image/png'], [JPG, 'image/jpeg'], [WEBP, 'image/webp']]) assert.equal(HS.validatePicture(f(5e6, 'image/png', 'ai.png'), bytes).mime, mime);
  assert.match(HS.validatePicture(f(2000, 'image/svg+xml', 'x.svg'), SVG).reason, /SVG files are not accepted/);
  assert.match(HS.validatePicture(f(2000, 'image/png', 'x.png'), SVG).reason, /not a picture Helm can use/);
  assert.match(HS.validatePicture(f(2000, 'image/gif', 'x.gif'), GIF).reason, /not a picture Helm can use/);
  assert.match(HS.validatePicture(f(16 * 1024 * 1024, 'image/png', 'big.png'), PNG).reason, /over 15 MB/);
  assert.match(HS.validatePicture(f(0, 'image/png', 'e.png'), PNG).reason, /empty/);
  assert.equal(HS.PIC_MAX_BYTES, 15 * 1024 * 1024);
});

t('upload reuses the secure invite-media pipeline (re-encode = EXIF/GPS stripped, <= 2560 px); only the path is kept', () => {
  const add = fnSrc(b, 'screenPicAdd');
  assert.match(add, /const gate=screenPicGate\(\); if\(gate\)\{ say\(gate\); return false; \}/);
  assert.match(add, /S\.validatePicture\(file, head\)/);
  assert.match(add, /new File\(\[file\], 'screen\.'\+v\.ext, \{type:v\.mime\}\)/, 'named + typed from its own bytes');
  assert.match(add, /logoPathFromUrl\(await BPStore\.sites\.uploadPhoto\(currentQuoteId, named\)\)/);
  assert.match(add, /P\.screenPic=path; P\.screenMode='pic'; P\.screenPicW=Math\.round\(dims\.w\); P\.screenPicH=Math\.round\(dims\.h\);/);
  assert.match(add, /dims\.w\*dims\.h>80e6/);
  const blk = b.slice(b.indexOf('R200: a PICTURE on a screen'), b.indexOf('// R137: logo references -> short-lived signed links'));
  assert.ok(blk.length > 3000);
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML|toDataURL|readAsDataURL|data:/.test(blk), 'DOM API only; no data: URL anywhere in the picture flow');
  assert.match(blk, /fi\.accept='image\/png,image\/jpeg,image\/webp'/);
  assert.match(blk, /lw\.addEventListener\('paste'/, 'paste a picture (AI tools)'); assert.match(blk, /navigator\.clipboard\.read/);
  assert.match(fnSrc(b, 'screenPicGate'), /builderInTrial\(\)\) return SCREEN_PIC_TRIAL_MSG/);
  // the store's uploadPhoto re-encodes on a canvas and caps the size (unchanged here)
  const sa = read('public/store-api.js'); const up = sa.slice(sa.indexOf('async uploadPhoto('), sa.indexOf('async mediaUrls('));
  assert.match(up, /ugPrepareImage\(file, \{ maxBytes: INVITE_IMG_MAX, maxInput: INVITE_IMG_MAX \* 3, maxPx: 2560/);
  assert.match(up, /supa\.storage\.from\("invite-media"\)\.upload\(path, img\.blob/);
  assert.match(read('supabase/functions/verify-upload/sniff.ts'), /"invite-media": \{ mimes: \["image\/png", "image\/jpeg", "image\/webp", "image\/gif"\]/);
});

t('drawing: picture mode draws only the picture (Fit = contain with bars, Fill = cover); the board template splits names on &', () => {
  const calls = []; const drawn = [];
  const ctx = new Proxy({ fillText: (s) => drawn.push(s), measureText: (s) => ({ width: s.length * 10 }), drawImage: (...a) => calls.push(a),
    createLinearGradient: () => ({ addColorStop() {} }), createRadialGradient: () => ({ addColorStop() {} }) },
  { get: (o, k) => (k in o ? o[k] : () => {}), set: () => true });
  const img = { naturalWidth: 1000, naturalHeight: 1000 };
  HS.draw(ctx, 1600, 900, HS.rawContent({ screenMode: 'pic', screenPic: PATH, title: 'hidden' }), { pic: img });
  assert.equal(drawn.length, 0, 'no text over a picture'); assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(1).map(Math.round), [350, 0, 900, 900], 'Fit: whole square centred');
  calls.length = 0; HS.draw(ctx, 1600, 900, HS.rawContent({ screenMode: 'pic', screenPic: PATH, screenFit: 'cover' }), { pic: img });
  assert.deepEqual(calls[0].slice(1).map(Math.round), [0, -350, 1600, 1600], 'Fill: covers, centred crop');
  calls.length = 0; HS.draw(ctx, 1600, 900, HS.rawContent({ screenMode: 'pic', screenPic: PATH }), {});
  assert.equal(calls.length, 0, 'not loaded yet: a dark face, never the old text');
  drawn.length = 0; HS.draw(ctx, 600, 900, HS.contentOf({ type: 'welcomeboard', properties: { screenTheme: 'royal', brand: 'Priya & Arjun', title: 'Sangeet', dateLine: '12 Dec' } }, []));
  for (const w of ['Welcome', 'Priya', '&', 'Arjun', 'Sangeet', '12 Dec']) assert.ok(drawn.includes(w), w);
  assert.deepEqual(HS.BOARD_FIELDS.map((f) => f[0]).sort(), HS.FIELDS.map((f) => f[0]).sort(), 'same 5 words, board labels');
});

t('3D: screens take their frame from faceOf; colour / logo / picture alone now show (R200 fix); board sizes + standee + face', () => {
  assert.match(b3, /SCR=!!\(VR\.screenTheme\|\|VR\.title\|\|VR\.brand\|\|VR\.tagline\|\|VR\.subtitle\|\|VR\.dateLine\|\|VR\.screenMirror\|\|VR\.screenBg\|\|VR\.screenLogo\|\|VR\.screenMode\)/);
  for (const [ty, fb] of [['ledscreen', 'Math.max(8,w*0.4)'], ['videowall', 'Math.max(8,d)']]) {
    const i = b3.indexOf("case '" + ty + "': {"), seg = b3.slice(i, i + 700);
    assert.ok(seg.includes('scrFrame(it, ' + fb + ')'), ty); }
  assert.match(b3, /const sh=scrFrame\(it, Math\.max\(6,Math\.round\(w\*9\/16\)\)\), base=2;/);
  assert.match(b3, /const H2=scrFrame\(it, Math\.max\(9,Math\.min\(16,w\*1\.8\)\)\), base=1/);
  assert.match(b3, /const pic=c\.pic && HS\.logoImage \? HS\.logoImage\(c\.pic\) : null;/); assert.match(b3, /HS\.draw\(x, W, H, c, \{ side, logo, pic \}\)/);
  const wb = b3.slice(b3.indexOf("case 'welcomeboard': {"), b3.indexOf("case 'entrancegate': {"));
  assert.match(wb, /HSb\.boardOf\(it\)/); assert.match(wb, /VAR\.style==='standee'/); assert.match(wb, /screenFace\(pg, it, scb, bw, bh, 0, 0, 0\.07, \{ slot:':board' \}\)/);
  assert.match(wb, /const bw=Math\.max\(2\.4,w\*0\.85\), bh=bw\*1\.3;/, 'the old board when no size / content / standee');
  assert.match(b3, /const sc2=sg\.side && sc\.pic \? Object\.assign\(\{\}, sc, \{ pic:'' \}\) : sc;/, 'stage side panels keep theme + brand');
  assert.match(b3, /const side=!!opt\.side \|\| \(!c\.pic && !c\.board && hFt>wFt\*1\.2\);/, 'portrait text screens laid out as a panel');
});

t('2D: the picture across the screen (SVG <image>, signed link, exported as pixels like the logo); waits for pictures before capture', () => {
  const p2 = fnSrc(b, 'screenPic2D');
  assert.match(p2, /class:'scr-logo scr-pic'/); assert.match(p2, /preserveAspectRatio:'xMidYMid slice'/); assert.match(p2, /im\.setAttribute\('data-logo', sc\.pic\)/);
  assert.match(fnSrc(b, 'screenFace2D'), /if\(sc\.pic\)\{/); assert.match(fnSrc(b, 'screenBand2D'), /if\(sc\.pic\)\{/);
  assert.match(fnSrc(b, 'screenLogosReady'), /return \[c\.logo, c\.pic\];/);
  assert.match(pru, /var pic = spec\.content && spec\.content\.pic && S\.logoImage \? S\.logoImage\(spec\.content\.pic\) : null;/);
});

t('3 screens (centre + 2 sides): a toolbox tile (shown in "most used"), each screen its own content; stage = centre screen', () => {
  assert.match(b, /const TOOL_PRESETS = \{ screens3: \{ after:'ledscreen', label:'3 screens \(centre \+ 2 sides\)' \} \};/);
  const common = b.slice(b.indexOf('const COMMON_TOOLS = new Set(['), b.indexOf(']);', b.indexOf('const COMMON_TOOLS = new Set([')));
  for (const ty of ['ledscreen', 'welcomeboard']) assert.ok(common.includes("'" + ty + "'"), ty + ' in most used');
  assert.match(b, /if\(t\.dataset\.preset==='screens3'\) addScreenSet\(\);/);
  const add = fnSrc(b, 'addScreenSet');
  assert.match(add, /if\(RO\) return;/); assert.match(add, /s\.properties\.screenAspect='9:16'/); assert.match(add, /c\.properties\.screenAspect='16:9'/);
  assert.match(add, /P\.screenLayout='single'/); assert.ok(!/screenMirror/.test(add), 'no mirroring: each screen has its own content');
  assert.match(add, /commit\(\); renderAll\(\);/, 'one Undo step');
  assert.match(b, /b3\.id='scr_set3'/, 'stage inspector button');
  assert.ok(!/screens3/.test(b.slice(b.indexOf('const DEFAULT_PRICES = {'), b.indexOf('\n};', b.indexOf('const DEFAULT_PRICES = {')))), 'the preset is never priced as itself');
});

t('Welcome Board: sizes 2x3 / 3x4 / 4x6 / custom, easel or standee, picture OR a ready design, priced by the existing rate', () => {
  assert.deepEqual(HS.BOARD_SIZES.map((s) => s[0]), ['', '2x3', '3x4', '4x6', 'custom']);
  assert.deepEqual(HS.BOARD_THEMES, ['floral', 'royal', 'minimal', 'marigold', 'blackgold']);
  assert.match(b, /welcomeboard: \[\['','On a gold easel'\],\['standee','Standee \(flat board on feet\)'\]\],/);
  assert.match(b, /entrancegate:25000, phoolchadar:6000, jhoola:12000, haldi:18000, mehendi:15000, selfieframe:3500, welcomeboard:2500,/, 'existing per-item rate kept (Settings can change it)');
  const ui = fnSrc(b, 'screenPicturePanel');
  assert.match(ui, /select\('scr_board','Board size',S\.BOARD_SIZES/); assert.match(ui, /numIn\('scr_bw','Width \(ft\)'/); assert.match(ui, /'Theme template'/);
  assert.match(fnSrc(b, 'stageScreenMount'), /\(board \? \['', \.\.\.S\.BOARD_THEMES\] : S\.THEME_ORDER\)/);
  assert.match(fnSrc(b, 'stageScreenMount'), /\(board \? S\.BOARD_FIELDS : S\.FIELDS\)/);
});

t('cache-busters + tour + styles', () => {
  for (const v of ['stage-screen.js?v=5', 'builder.js?v=96', 'builder-3d.js?v=35', 'builder.css?v=41', 'photo-render-ui.js?v=13', 'page-tours.js?v=63']) assert.ok(html.includes(v), v);
  for (const f of ['public/capture.html', 'public/try.html']) assert.match(read(f), /stage-screen\.js\?v=5/, f);
  const pt = read('public/page-tours.js'); assert.match(pt, /Toolbox: 3 screens \(centre \+ 2 sides\) and Welcome Board/); assert.match(pt, /Upload a picture/);
  for (const c of ['.scr-mode', '.scr-guide', '.scr-warn', '.scr-prev', '.isec.screen select{max-width:100%}']) assert.ok(css.includes(c), c);
});

let n = 0;
for (const [name, fn] of tests) { try { fn(); n++; } catch (e) { console.error('✗ ' + name); throw e; } }
console.log('r200-builder-screens: ' + n + '/' + tests.length + ' passed');
