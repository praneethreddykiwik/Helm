/* r160-render-screen-history.test.mjs - R160 photo render:
 * A) the stage / LED screen content (theme, colours, title / brand / tagline, logo) reaches the photo: screen specs
 *    (HelmScreen.photoSpecs), the data sent to render-photo (never the logo's storage path), the prompt no longer
 *    forbids the planned screen text / logo, and an older render-photo falls back to the 4 base pictures.
 * B) "Past renders for this event": the stored photo always loads - the Postgres base64 line breaks are accepted,
 *    each Show re-reads the photo from the database with one retry, a failure offers Reload, a missing photo says so.
 * Pure Node (vm + small DOM stubs). Never calls the image service. */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const rd = (f) => readFileSync(join(ROOT, f), 'utf8');
const req = createRequire(import.meta.url);
const P = req('../public/photo-render-prompt.js');
const S = req('../public/stage-screen.js');
let n = 0; const tests = [];
const t = (name, fn) => tests.push([name, fn]);

const LOGO = 'a0000000-0000-4000-8000-000000000001/a0000000-0000-4000-8000-00000000da01/b0000000-0000-4000-8000-000000000001.png';
const OWNER = { screenTheme: 'neon', screenBg: '#0b2a5b', title: 'Annual Day', brand: 'CRISKA', tagline: 'Building intelligent futures', screenLogo: LOGO };
const LAY = [
  { id: 's1', type: 'stage', x: 80, y: 5, width: 40, height: 16, properties: { ...OWNER } },
  { id: 'l1', type: 'led', x: 20, y: 5, width: 12, height: 2, properties: { screenMirror: true } },
  { id: 'l2', type: 'led', x: 160, y: 5, width: 12, height: 2, properties: { screenMirror: true } },
  { id: 'v1', type: 'videowall', x: 10, y: 100, width: 12, height: 2, properties: {} },
  { id: 'c1', type: 'seatblock', x: 60, y: 60, width: 80, height: 40, properties: { rows: 8, cols: 20 } },
];

// ---------------- A) screen specs ----------------
t('photoSpecs: the owner screen - theme, custom navy, auto text colour, logo; mirrors merged; blank screens left out', () => {
  const sp = S.photoSpecs(LAY);
  assert.equal(sp.length, 2);
  const m = sp[0];
  assert.deepEqual([m.kind, m.layout, m.theme, m.themeName, m.bg, m.ink, m.customBg, m.title, m.brand, m.tagline, m.logo, m.logoRef],
    ['stage', 'triple', 'neon', 'Concert Neon', '#0b2a5b', '#ffffff', true, 'Annual Day', 'CRISKA', 'Building intelligent futures', true, LOGO]);
  assert.equal(m.ink, S.paletteOf(S.rawContent(LAY[0].properties)).ink, 'the same auto text colour as the 3D screen');
  assert.deepEqual([sp[1].kind, sp[1].type, sp[1].count, sp[1].mirrored], ['screen', 'led', 2, true]);
  assert.equal(S.photoSpecs([{ type: 'stage', properties: { ...OWNER, screenLayout: 'none' } }]).length, 0, 'plain backdrop: no screen');
  assert.equal(S.photoSpecs([{ type: 'stage', properties: {} }]).length, 0);
  assert.equal(S.photoSpecs(new Array(9).fill(0).map((_, i) => ({ type: 'ledscreen', properties: { title: 'T' + i } }))).length, 4);
});

t('prompt: with screen content the photo may show it (no "no readable text / logos" against the screens)', () => {
  const sp = S.photoSpecs(LAY);
  for (const eventType of ['corporate', 'concert']) {
    const p = P.build({ items: LAY, world: { w: 200, h: 140 }, eventType, screens: sp }).prompt;
    assert.match(p, /SCREEN CONTENT section at the end of this prompt is authoritative/);
    assert.match(p, /EXCEPT the planned screen content \(words, colours and logo\)/);
    assert.match(p, /Image 5 onward\) are screen references/);
    assert.doesNotMatch(p, /No other words, logos or numbers on any screen/, 'the logo is no longer forbidden on the screen');
    for (const m of p.matchAll(/readable text or logos[^;.\n]*/g)) assert.match(m[0], /except the planned stage \/ LED screen content/, eventType + ': ' + m[0]);
    assert.match(p, /no text other than the planned screen content\./);
    assert.ok(p.length <= P.PROMPT_LIMIT - 3500 + 1, 'room left for the server section');
  }
  // a layout without screen content: wording exactly as before
  const plain = P.build({ items: [LAY[4]], world: { w: 200, h: 140 }, eventType: 'corporate' }).prompt;
  assert.doesNotMatch(plain, /SCREEN CONTENT section/);
  assert.match(plain, /LED screens may show tasteful visuals/);
  assert.match(plain, /no alternatives, no text\./);
});

// ---------------- DOM stub + photo-render-ui in a vm ----------------
function el(tag) {
  const o = { tagName: tag, hidden: false, value: '', disabled: false, textContent: '', className: '', children: [], listeners: {}, attrs: {}, parent: null,
    addEventListener(k, f) { (this.listeners[k] ||= []).push(f); }, focus() {}, replaceChildren() { this.children = []; },
    appendChild(c) { this.children.push(c); c.parent = this; return c; }, querySelectorAll() { return []; },
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this); this.removed = true; },
    setAttribute(k, v) { this.attrs[k] = String(v); }, removeAttribute(k) { this.attrs[k] = undefined; if (k === 'src') this._src = ''; },
    click() { const ev = { prevented: false, preventDefault() { this.prevented = true; } }; (this.listeners.click || []).forEach((f) => f(ev)); this.clicks = (this.clicks || 0) + 1; return ev; } };
  Object.defineProperty(o, 'src', { get() { return this._src || ''; }, set(v) { this._src = v; setTimeout(() => (/broken/.test(v) ? this.onerror && this.onerror() : this.onload && this.onload()), 0); } });
  return o;
}
const ids = {}; const $ = (id) => (ids[id] ||= el('div'));
const toasts = [];
let imageImpl = async () => null, listCalls = 0, rows = [];
const win = { HelmPhotoPrompt: P, HelmScreen: S, BPUI: { toast: (m, o) => toasts.push([m, (o || {}).type]) },
  URL: { createObjectURL: (b) => 'blob:helm/' + b.size }, atob: (s) => Buffer.from(s, 'base64').toString('binary'), Blob,
  BPStore: { photoRender: { available: () => true, list: async () => { listCalls++; return rows; }, image: (id) => imageImpl(id), useInBooklet: async () => ({ ok: true }) } },
  __helmPhotoCtx: () => ({ quoteId: 'q1', supported: true, items: LAY, world: { w: 200, h: 140 } }) };
const doc = { readyState: 'complete', getElementById: $, createElement: (tg) => el(tg), querySelector: () => null, addEventListener() {} };
vm.runInNewContext(rd('public/photo-render-ui.js'), Object.assign({ window: win, document: doc, setTimeout, clearTimeout, Promise, Date, AbortController, console, URL: win.URL, atob: win.atob, Blob }, win));
const UI = win.HelmPhotoRenderUI;
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const JPEG = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).toString('base64');
const find = (node, pred) => { if (pred(node)) return node; for (const c of node.children || []) { const f = find(c, pred); if (f) return f; } return null; };
const btn = (card, text) => find(card, (x) => x.tagName === 'button' && x.textContent === text);

t('screen data sent to render-photo: plain data, never the logo storage path; logo only when its picture loaded', () => {
  const sp = UI.screenSpecs(LAY), pay = UI.screenPayload(sp);
  const s = JSON.stringify(pay);
  assert.doesNotMatch(s, /a0000000-0000-4000-8000|logoRef|content/);
  assert.equal(pay[0].title, 'Annual Day'); assert.equal(pay[0].theme, 'neon'); assert.equal(pay[0].bg, '#0b2a5b');
  assert.equal(pay[0].logo, false, 'logo not loaded (no resolver in Node) -> described as the brand letter, like the 3D view shows');
  assert.ok(UI.oldServerRefusal({ status: 400, code: 'send 1 to 4 reference pictures' }));
  assert.ok(!UI.oldServerRefusal({ status: 400, code: 'prompt is required' }));
  assert.ok(!UI.oldServerRefusal({ status: 429, code: 'render_quota' }));
});

// ---------------- B) past renders ----------------
t('store-api: a stored photo with Postgres base64 line breaks loads (root cause of the broken past renders)', () => {
  const src = rd('public/store-api.js');
  const i = src.indexOf('  function photoDataUrl(r) {'), j = src.indexOf('\n  }\n', i) + 4;
  const photoDataUrl = new Function('BOOKLET_IMG_MIME', src.slice(i, j) + '\nreturn photoDataUrl;')(/^image\/(jpeg|png|webp)$/);
  const raw = Buffer.alloc(300, 7); raw[0] = 0xff; raw[1] = 0xd8; raw[2] = 0xff;
  const b64 = raw.toString('base64'), pg = b64.match(/.{1,76}/g).join('\n');   // what encode(data, 'base64') returns
  assert.ok(pg.includes('\n'));
  assert.equal(photoDataUrl({ mime: 'image/jpeg', data: pg }), 'data:image/jpeg;base64,' + b64);
  assert.equal(photoDataUrl({ mime: 'image/jpeg', data: pg + '\r\n' }), 'data:image/jpeg;base64,' + b64);
  assert.equal(photoDataUrl({ mime: 'text/html', data: b64 }), null);
  assert.equal(photoDataUrl({ mime: 'image/jpeg', data: '<script>' }), null);
  assert.match(src, /data: String\(r\.data\)\.replace\(\/\[\\r\\n\\t \]\+\/g, ""\)/, 'fresh renders normalised too');
});

t('past render: placeholder (no broken image), first load fails -> one automatic retry -> shown via blob link', async () => {
  let calls = 0; imageImpl = async () => { calls++; if (calls === 1) throw new Error('network'); return JPEG; };
  const card = UI.card({ id: 'r1', style: 'golden', created_at: '2026-11-01T10:00:00Z' }, null, {});
  const img = find(card, (x) => x.tagName === 'img'), ph = find(card, (x) => x.className === 'ph-ph');
  assert.equal(img.hidden, true); assert.equal(img.src, ''); assert.equal(ph.textContent, 'Photo not shown yet');
  btn(card, 'Show').click();
  await tick(900);
  assert.equal(calls, 2, 'retried once');
  assert.equal(img.hidden, false); assert.equal(ph.hidden, true);
  assert.match(img.src, /^blob:helm\//);
  assert.equal(btn(card, 'Show'), null, 'Show gone once loaded');
  const dl = find(card, (x) => x.tagName === 'a'); assert.equal(dl.href, img.src);
});

t('past render: still failing -> "Reload" + plain message; Reload then works', async () => {
  let ok = false, calls = 0; imageImpl = async () => { calls++; return ok ? JPEG : null; };
  toasts.length = 0;
  const card = UI.card({ id: 'r2' }, null, {});
  btn(card, 'Show').click();
  await tick(900);
  assert.equal(calls, 2);
  const ph = find(card, (x) => x.className === 'ph-ph');
  assert.equal(ph.textContent, 'This photo couldn’t be loaded.');
  assert.ok(btn(card, 'Reload'), 'Reload offered');
  assert.equal(toasts.at(-1)[1], 'err');
  ok = true; btn(card, 'Reload').click(); await tick(20);
  assert.equal(find(card, (x) => x.tagName === 'img').hidden, false);
});

t('past render: Download of an old render loads it first, then downloads; a missing photo says so (no retry)', async () => {
  imageImpl = async () => JPEG;
  const card = UI.card({ id: 'r3' }, null, {});
  const dl = find(card, (x) => x.tagName === 'a');
  const ev = dl.click(); assert.equal(ev.prevented, true, 'first click waits for the photo');
  await tick(20);
  assert.match(dl.href, /^blob:/); assert.equal(dl.clicks, 2, 're-clicked with the link set');
  let calls = 0; imageImpl = async () => { calls++; throw Object.assign(new Error('render not found'), { code: 'P0002' }); };
  const gone = UI.card({ id: 'r4' }, null, {});
  btn(gone, 'Show').click(); await tick(900);
  assert.equal(calls, 1);
  assert.equal(find(gone, (x) => x.className === 'ph-ph').textContent, 'This photo is no longer available.');
  assert.equal(btn(gone, 'Show'), null); assert.equal(btn(gone, 'Reload'), null);
  assert.equal(find(gone, (x) => x.tagName === 'a').hidden, true);
});

t('history: every open re-reads the list from the database; one card per render, none pre-loaded', async () => {
  rows = [{ id: 'a' }, { id: 'b' }];
  const before = listCalls;
  await UI.loadHistory(); await UI.loadHistory();
  assert.equal(listCalls - before, 2);
  const list = $('phHistList');
  assert.equal(list.children.length, 2);
  assert.ok(list.children.every((c) => find(c, (x) => x.tagName === 'img').src === ''));
});

t('wiring: versions bumped, builder passes the logo wait, render-photo takes the screen pictures', () => {
  const bh = rd('public/builder.html');
  for (const v of ['stage-screen.js?v=4', 'photo-render-prompt.js?v=12', 'photo-render-ui.js?v=11', 'builder.js?v=91', 'builder.css?v=40', 'store-api.js?v=348']) assert.ok(bh.includes(v), v);
  assert.match(rd('public/builder.js'), /logosReady: \(\) => screenLogosReady\(\)/);
  const fn = rd('supabase/functions/render-photo/index.ts');
  assert.match(fn, /MAX_SCREEN_IMAGES = 2, MAX_LOGO_IMAGES = 1/);
  assert.match(fn, /fd\.append\("prompt", fullPrompt\)/);
  assert.match(rd('public/builder.css'), /\.ph-card \.ph-ph\{/);
});

for (const [name, fn] of tests) { await fn(); n++; console.log('  ✓ ' + name); }
console.log('\nr160-render-screen-history: ' + n + ' passed.');
