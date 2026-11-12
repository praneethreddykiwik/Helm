#!/usr/bin/env node
/* r157-tour-xscroller.test.mjs - the page tour on a LANDSCAPE phone skipped top-bar items that were scrolled out of
 * the builder's horizontally scrolling toolbar (pick() treated "left of / right of the viewport" as an off-canvas
 * drawer), so only ~8 of 20 steps ran. Fix (public/tour.js):
 *   - xScroller(t, vw): nearest overflow-x auto/scroll ancestor that really overflows and is itself on screen
 *   - pick(): an off-screen target is still usable when such a bar holds it
 *   - revealInXScroller(t): before measuring, scrollIntoView({block:'nearest', inline:'center'}) - only when the
 *     target is in such a bar AND clipped by it; a no-op otherwise (desktop unchanged)
 * The helpers are pulled out of the real source and run against small fake elements. Pure Node, no deps.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(join(ROOT, 'public', 'tour.js'), 'utf8');
let passed = 0;
const t = (n, f) => { f(); passed++; console.log('  ✓ ' + n); };

function fnSrc(name) {
  const i = SRC.indexOf('function ' + name + '(');
  assert.ok(i > -1, name + '() must exist in tour.js');
  let d = 0, j = SRC.indexOf('{', i);
  for (; j < SRC.length; j++) { if (SRC[j] === '{') d++; else if (SRC[j] === '}' && --d === 0) break; }
  return SRC.slice(i, j + 1);
}

// tiny fake DOM: elements with a rect, computed style and scroll sizes
const body = { tag: 'body' }, html = { tag: 'html' };
function el(o) {
  return { parentElement: o.parent || body, style: o.style || {}, scrollWidth: o.sw || 0, clientWidth: o.cw || 0,
    getBoundingClientRect: () => o.rect, calls: [], scrollIntoView(arg) { this.calls.push(arg); } };
}
const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
function load(vw) {
  const doc = { body, documentElement: Object.assign(html, { clientWidth: vw }) };
  const gcs = (e) => Object.assign({ overflowX: 'visible', position: 'static' }, e.style);
  const f = new Function('document', 'window', 'getComputedStyle',
    fnSrc('xScroller') + '\n' + fnSrc('revealInXScroller') + '\nreturn { xScroller, revealInXScroller };');
  return f(doc, { innerWidth: vw }, gcs);
}

const VW = 844;
const bar = () => el({ rect: rect(0, 0, VW, 48), style: { overflowX: 'auto' }, sw: 1900, cw: VW });

t('pick() keeps an off-screen target that sits in an on-screen sideways-scrolling bar', () => {
  assert.match(SRC, /if \(\(r\.right <= 0 \|\| r\.left >= vw\) && !xScroller\(t, vw\)\) continue;/);
});

t('place() reveals the target in its sideways bar BEFORE measuring it', () => {
  const i = SRC.indexOf('function place()');
  const a = SRC.indexOf('revealInXScroller(tgt)', i), m = SRC.indexOf('getBoundingClientRect', i);
  assert.ok(a > i && m > a, 'revealInXScroller(tgt) must run before the first measurement in place()');
});

t('xScroller finds the overflowing toolbar for an item scrolled past the right edge', () => {
  const { xScroller } = load(VW);
  const b = bar(), item = el({ parent: b, rect: rect(1300, 6, 90, 36) });
  assert.equal(xScroller(item, VW), b);
});

t('xScroller ignores a bar that does not overflow (desktop toolbar) and overflow:hidden boxes', () => {
  const { xScroller } = load(1440);
  const fits = el({ rect: rect(0, 0, 1440, 48), style: { overflowX: 'auto' }, sw: 1440, cw: 1440 });
  assert.equal(xScroller(el({ parent: fits, rect: rect(900, 6, 90, 36) }), 1440), null);
  const clip = el({ rect: rect(0, 0, 1440, 48), style: { overflowX: 'hidden' }, sw: 3000, cw: 1440 });
  assert.equal(xScroller(el({ parent: clip, rect: rect(2000, 6, 90, 36) }), 1440), null);
});

t('xScroller ignores an off-canvas drawer (its scroller is off screen) and stops at position:fixed', () => {
  const { xScroller } = load(VW);
  const drawer = el({ rect: rect(VW + 10, 0, 340, 390), style: { overflowX: 'auto' }, sw: 600, cw: 340 });
  assert.equal(xScroller(el({ parent: drawer, rect: rect(VW + 20, 40, 300, 30) }), VW), null);
  const fixed = el({ rect: rect(VW + 10, 0, 340, 390), style: { position: 'fixed' } });
  const outer = el({ rect: rect(0, 0, VW, 390), style: { overflowX: 'auto' }, sw: 2000, cw: VW });
  fixed.parentElement = outer;
  assert.equal(xScroller(el({ parent: fixed, rect: rect(VW + 20, 40, 300, 30) }), VW), null);
});

t('revealInXScroller scrolls a clipped bar item with block:nearest + inline:center', () => {
  const { revealInXScroller } = load(VW);
  const b = bar(), item = el({ parent: b, rect: rect(1300, 6, 90, 36) });
  assert.equal(revealInXScroller(item), true);
  assert.deepEqual(item.calls, [{ block: 'nearest', inline: 'center', behavior: 'auto' }]);
  const half = el({ parent: bar(), rect: rect(VW - 30, 6, 90, 36) });   // partly clipped at the right edge
  assert.equal(revealInXScroller(half), true);
  const left = el({ parent: bar(), rect: rect(-200, 6, 90, 36) });      // scrolled out to the left
  assert.equal(revealInXScroller(left), true);
});

t('revealInXScroller is a no-op when the item is already fully in view, or not in a sideways bar', () => {
  const { revealInXScroller } = load(VW);
  const inView = el({ parent: bar(), rect: rect(200, 6, 90, 36) });
  assert.equal(revealInXScroller(inView), false); assert.equal(inView.calls.length, 0);
  const plain = el({ rect: rect(1500, 6, 90, 36) });
  assert.equal(revealInXScroller(plain), false); assert.equal(plain.calls.length, 0);
  const { revealInXScroller: desk } = load(1440);
  const fits = el({ rect: rect(0, 0, 1440, 48), style: { overflowX: 'auto' }, sw: 1440, cw: 1440 });
  const d = el({ parent: fits, rect: rect(1200, 6, 90, 36) });
  assert.equal(desk(d), false); assert.equal(d.calls.length, 0);
});

console.log(`\nr157-tour-xscroller: ${passed} assertion(s) passed.`);
