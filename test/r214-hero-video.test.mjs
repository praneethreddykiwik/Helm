// R214 landing speed: phones get a small (~1 MB) hero film instead of the 4.7 MB 720p one.
//  - the page markup names the phone files (hero-m.webm VP9 + hero-m.mp4 H.264 fallback, new names = fresh caches)
//  - home.js swaps to hero-hq.* on >=1024px screens (no Save-Data) and to hero.* on tablets / Save-Data desktops
//  - unchanged: poster first, film fetched only after the page load + idle, no film at all for
//    reduced-motion or Save-Data / 2G visitors (poster only until they press Play)
import assert from 'node:assert/strict';
import { readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const head = (p, n) => { const fd = openSync(new URL(p, root)); const b = Buffer.alloc(n); readSync(fd, b, 0, n, 0); closeSync(fd); return b; };
let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log('  ✓ ' + name); };

const INDEX = read('public/index.html'), JS = read('public/home.js');

t('phone film files exist, are about 1 MB, and are real VP9-WebM / fast-start MP4', () => {
  for (const f of ['hero-m.webm', 'hero-m.mp4']) {
    const size = statSync(new URL('public/home-assets/' + f, root)).size;
    assert.ok(size > 300 * 1000 && size <= 1.1 * 1000 * 1000, f + ' is ' + size + ' bytes');
  }
  assert.equal(head('public/home-assets/hero-m.webm', 4).toString('hex'), '1a45dfa3', 'hero-m.webm is an EBML/WebM file');
  const s = head('public/home-assets/hero-m.mp4', 65536).toString('latin1'), moov = s.indexOf('moov'), mdat = s.indexOf('mdat');
  assert.ok(moov > 0 && (mdat < 0 || moov < mdat), 'hero-m.mp4: moov before mdat (plays while downloading)');
  // phone film must stay smaller than the tablet one it replaces on phones
  assert.ok(statSync(new URL('public/home-assets/hero-m.webm', root)).size < statSync(new URL('public/home-assets/hero.webm', root)).size / 3);
});

t('page markup names the phone files; poster + preload=metadata kept; home.js version bumped', () => {
  assert.match(INDEX, /<video class="hero-video" id="heroVideo" muted loop playsinline preload="metadata" poster="\/home-assets\/hero-poster\.webp"[^>]*>\s*<source data-src="\/home-assets\/hero-m\.webm" type="video\/webm"><source data-src="\/home-assets\/hero-m\.mp4" type="video\/mp4">/);
  assert.ok(!/data-src="\/home-assets\/hero\.(webm|mp4)"/.test(INDEX), 'no eager 720p film in the markup');
  assert.match(INDEX, /<script src="\/home\.js\?v=(\d+)" defer><\/script>/);
  assert.ok(Number(INDEX.match(/home\.js\?v=(\d+)/)[1]) >= 42);
});

t('home.js: HQ on wide screens, 720p on tablets, phone files on phones (incl. sideways)', () => {
  assert.match(JS, /var heroPhone = !heroHQ && !!\(window\.matchMedia && window\.matchMedia\('\(max-width: 767px\), \(max-height: 500px\)'\)\.matches\);/);
  assert.match(JS, /if \(heroVideo && !heroPhone\) \{[\s\S]{0,200}\.replace\('\/hero-m\.', heroHQ \? '\/hero-hq\.' : '\/hero\.'\)/);
});

t('film still waits for the page: no fetch before load + idle; reduced motion / Save-Data = poster only', () => {
  assert.match(JS, /var liteData = !!netInfo\.saveData \|\| /);
  assert.match(JS, /var heroUserPaused = reduce \|\| liteData, heroVisible = false;/);
  assert.match(JS, /if \(!reduce && !liteData\) \{[\s\S]{0,400}afterLoadIdle\(heroGo\);/);
  const block = JS.slice(JS.indexOf('heroVideo.muted = true;'), JS.indexOf('afterLoadIdle(heroGo);'));
  assert.ok(block.length > 0 && !/loadV\(heroVideo\)/.test(block), 'no eager fetch before load + idle');
});

console.log(`r214-hero-video: ${passed} passed`);
