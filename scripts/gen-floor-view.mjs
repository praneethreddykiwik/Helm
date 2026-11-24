#!/usr/bin/env node
/* gen-floor-view.mjs - R253: the layout viewer draws with the PLANNER'S OWN code, never with a copy that can drift.
 *
 *   node scripts/gen-floor-view.mjs          rewrite public/floor-draw.js and public/floor-3d.js
 *   node scripts/gen-floor-view.mjs --check  exit 1 if one of them is stale (CI + test/r253-layout-viewer.test.mjs)
 *
 * public/floor-draw.js  the 2D drawing functions of public/builder.js (renderItem and what it needs, the grid, the margins,
 *                       the item clean-up) cut out WORD FOR WORD, plus the planner's light colours from builder.css.
 * public/floor-3d.js    public/builder-3d.js word for word inside a function, with the planner's globals passed in
 *                       (read-only: nothing can be edited or saved), plus the flowers-per-event-type rule of layout-wizard.js.
 *
 * builder.js, builder-3d.js and layout-wizard.js are only READ here: the planner itself is not changed by the viewer.
 * A function that was renamed / a marker that moved stops the generator with its name.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PUB = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const read = (f) => readFileSync(join(PUB, f), 'utf8');
const die = (m) => { throw new Error('gen-floor-view: ' + m); };

// a top-level function of builder.js: from its line to the first "}" in column 0 (or the same line for a one-liner)
function fn(src, name) {
  const at = src.indexOf('\nfunction ' + name + '(');
  if (at < 0) die('function ' + name + ' not found');
  const rest = src.slice(at + 1), first = rest.slice(0, rest.indexOf('\n') + 1), second = rest.slice(first.length);
  if (/^\S/.test(second) && second[0] !== '}') return first;
  const end = rest.indexOf('\n}');
  if (end < 0) die('end of ' + name + ' not found');
  return rest.slice(0, rest.indexOf('\n', end + 1) + 1);
}
// a top-level const of builder.js: one line, or a block that ends with "};" / "];" in column 0
function konst(src, name) {
  const m = new RegExp('\\nconst ' + name + '\\s*=').exec(src);
  if (!m) die('const ' + name + ' not found');
  const rest = src.slice(m.index + 1), line = rest.slice(0, rest.indexOf('\n') + 1);
  if (/[{\[]\s*(\/\/.*)?\n$/.test(line)) { const e = /\n[}\]];/.exec(rest); if (!e) die('end of ' + name); return rest.slice(0, e.index + e[0].length) + '\n'; }
  return line;
}
function between(src, a, b, what) {
  const i = src.indexOf(a); if (i < 0) die(what + ': start marker not found');
  const j = src.indexOf(b, i + a.length); if (j < 0) die(what + ': end marker not found');
  return src.slice(i, j);
}
// the planner's light palette (builder.css first :root block; the planner is always light today)
function palette(css) {
  const m = /:root\{([\s\S]*?)\n\}/.exec(css); if (!m) die('builder.css :root not found');
  const out = {}; for (const x of m[1].matchAll(/(--[\w-]+):([^;]+);/g)) out[x[1]] = x[2].trim();
  return out;
}

export function floorDraw() {
  const b = read('builder.js'), css = read('builder.css'), P = palette(css);
  const cats = {}; for (const k of ['structure', 'seating', 'av', 'security', 'logistics', 'safety', 'decor']) cats[k] = P['--c-' + k] || die('--c-' + k);
  // every colour a category ever had (light + the dark copies), so a plan saved in another theme still follows its category
  const known = new Set(); for (const x of css.matchAll(/--c-[a-z]+:(#[0-9a-fA-F]{3,8})/g)) known.add(x[1].toLowerCase());
  const pal = {}; for (const k of ['--canvas', '--grid', '--grid-strong', '--ink', '--ink-3', '--panel', '--panel-2', '--accent']) pal[k] = P[k] || die(k);
  // the words on a screen are not .lbl: they use the planner page's own body font (builder-v2.css)
  const screenFont = ((/html\[data-hb-theme\] body \{ font-family:([^;}]+)/.exec(read('builder-v2.css')) || die('builder-v2.css body font'))[1]).trim();
  const grid = between(b, '  // --- grid ---\n', '  // --- items ---', 'renderAll grid');
  if (!/drawOrder2D\(store\.items\)\.forEach\(it=> svg\.appendChild\(renderItem\(it\)\)\);/.test(b)) die('renderAll item loop changed');
  const parts = [
    konst(b, 'PX_PER_FT'), konst(b, 'DEFAULT_WORLD'), konst(b, 'FT_PER_M'), konst(b, 'CATS'), konst(b, 'ASSETS'),
    konst(b, 'HEXRE'), konst(b, 'MAX_ITEMS'), konst(b, 'clamp'), konst(b, 'round1'), konst(b, 'COMFORT_PITCH'), konst(b, 'CONG_COLORS'), konst(b, 'SVGNS'),
    fn(b, 'seatPitchFt'), fn(b, 'congestionOf'), fn(b, 'cellFt'), fn(b, 'el'), fn(b, 'renderMargins'), fn(b, 'drawOrder2D'),
    fn(b, 'screenContent'), fn(b, 'screenPlaceholderOn'), fn(b, 'fitChars'), fn(b, 'screenText2D'), fn(b, 'screenPlaceholder2D'), fn(b, 'screenLogo2D'), fn(b, 'screenPic2D'),
    fn(b, 'screenBand2D'), fn(b, 'screenFace2D'), konst(b, 'STAGE_STEPS'), fn(b, 'stageStepOffsets'), fn(b, 'stairStepCount'), fn(b, 'renderItem'),
    fn(b, 'clampItem'), fn(b, 'sanitizeItem'), fn(b, 'dedupeIds'), fn(b, 'sanitizeMargins')
  ].join('');
  return `/* GENERATED from builder.js + builder.css by scripts/gen-floor-view.mjs - do not edit by hand.
 * The planner's 2D drawing, word for word, for the read-only layout viewer (floor-view.js) and the Floor plan card (event-floor.js).
 *   HelmFloorDraw.prepare(floor)        -> { items, world: { w, h }, margins, unit } cleaned exactly as the planner opens a layout
 *   HelmFloorDraw.svg(plan, opts)       -> the <svg> the planner's canvas shows (viewBox in plan pixels, PX per foot)
 *   HelmFloorDraw.PX / PALETTE / CAT    -> 12 px per foot, the planner's colours
 * floor = event_floor_get's answer (0397) or a saved version's data. Needs builder-tools.js + stage-screen.js. Nothing is saved. */
(function (global) {
if (!global.document) return;
var window = global;
const FONT = ${JSON.stringify(P['--font'] || die('--font'))}, SCREEN_FONT = ${JSON.stringify(screenFont)};
const PALETTE = Object.freeze(${JSON.stringify(pal)});
const C_LIGHT = Object.freeze(${JSON.stringify(cats)}), C_KNOWN = ${JSON.stringify([...known].sort())};
const RO = true;                                   // the viewer never shows an edit hint or a margin handle
const WORLD = { w: 0, h: 0 };
let store = { items: [], grid: { show: true, unit: 'ft', snap: true }, margins: { left: 0, right: 0, top: 0, bottom: 0 }, view: { zoom: 1 } }, svg = null, seq = 0;
const isSelected = () => false, nid = () => 'fv_' + (++seq).toString(36), catColor = (k) => C_LIGHT[k];
/* ======== from builder.js (word for word) ======== */
${parts}function drawGrid(){
${grid}}
/* ======== end of builder.js ======== */
// the same steps as the planner's applyLayout(): hall size first, then clean every item, then the margins
function prepare(floor) {
  const f = floor || {}, v = f.venue || {}, hall = f.hall || {};
  const rf = (f.scale && f.scale.worldFt) || v.room || f.world || { w: hall.len, h: hall.wid };
  WORLD.w = DEFAULT_WORLD.w; WORLD.h = DEFAULT_WORLD.h;
  if (rf && +rf.w && +rf.h && isFinite(rf.w) && isFinite(rf.h)) { WORLD.w = clamp(Math.round(+rf.w), 20, 1000); WORLD.h = clamp(Math.round(+rf.h), 20, 1000); }
  const items = JSON.parse(JSON.stringify((Array.isArray(f.items) ? f.items : []).slice(0, MAX_ITEMS))).filter((it) => it && typeof it === 'object' && !Array.isArray(it));
  items.forEach((it) => {
    const full = Object.prototype.hasOwnProperty.call(it, 'colorCustom');
    sanitizeItem(it);
    const c = it.color.trim().toLowerCase();
    // a saved version says if the colour was chosen by hand; event_floor_get (0397) does not, so a category colour means "not chosen"
    if (!HEXRE.test(it.color.trim()) || (full ? !it.colorCustom : C_KNOWN.indexOf(c) >= 0)) it.color = catColor(it.category);
    clampItem(it);
  });
  dedupeIds(items);
  return { items, world: { w: WORLD.w, h: WORLD.h }, margins: sanitizeMargins(f.margins), unit: ((f.grid && f.grid.unit) || f.unit) === 'm' ? 'm' : 'ft' };
}
function svgOf(plan, o) {
  o = o || {};
  WORLD.w = plan.world.w; WORLD.h = plan.world.h;
  store = { items: plan.items, grid: { show: o.grid !== false, unit: plan.unit, snap: true }, margins: plan.margins, view: { zoom: o.zoom || 1 } };
  const W = WORLD.w * PX_PER_FT, H = WORLD.h * PX_PER_FT;
  svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'fv-plan', preserveAspectRatio: 'xMidYMid meet' });
  drawGrid();
  drawOrder2D(store.items).forEach(it=> svg.appendChild(renderItem(it)));
  renderMargins();
  const out = svg; svg = null;
  // self-contained colours + label type, so no page rule (svg text, a theme) can change the plan
  Object.keys(PALETTE).forEach((k) => out.style.setProperty(k, PALETTE[k])); out.style.setProperty('--c-logistics', C_LIGHT.logistics);
  out.querySelectorAll('text').forEach((t) => { const st = t.style; st.fontSize = (+t.getAttribute('font-size') || 7) + 'px'; st.letterSpacing = 'normal'; st.pointerEvents = 'none'; st.fontFamily = SCREEN_FONT;
    if (t.getAttribute('class') === 'lbl') { st.fontFamily = FONT; st.fontWeight = '600'; st.fill = 'var(--ink)'; st.paintOrder = 'stroke'; st.stroke = 'var(--canvas)'; st.strokeWidth = '3px'; st.strokeLinejoin = 'round'; } });
  // a picture, not a list of buttons: the planner's keyboard stops are for editing
  out.querySelectorAll('.obj').forEach((n) => { n.removeAttribute('tabindex'); n.removeAttribute('role'); n.removeAttribute('aria-pressed'); n.setAttribute('aria-hidden', 'true'); n.removeAttribute('aria-label'); });
  return out;
}
global.HelmFloorDraw = Object.freeze({ prepare, svg: svgOf, PX: PX_PER_FT, PALETTE, CAT: C_LIGHT, FT_PER_M, labelOf: (t) => (Object.prototype.hasOwnProperty.call(ASSETS, t) && ASSETS[t].label) || '' });
})(typeof window !== 'undefined' ? window : globalThis);
`;
}

export function floor3d() {
  let s = read('builder-3d.js');
  const lw = read('layout-wizard.js');
  const must = (a, c, to) => { const n = s.split(a).length - 1; if (n !== c) die('builder-3d.js: expected ' + c + ' x ' + a + ', found ' + n); s = s.split(a).join(to); };
  must("window.addEventListener(", 2, "H.on(");                  // the viewer adds and removes these itself (no leak when it closes)
  must("localStorage.setItem('bps.labels3d',liveLabels)", 1, "void 0");   // the viewer never writes the planner's label choice
  // the viewer hands over its own elements, and the planner's window.__ hooks land on a private object, not on the page
  must("document.getElementById('scene3d')", 1, 'H.canvas'); must("document.getElementById('stage3d')", 1, 'H.stage'); must("document.querySelector('.viewport')", 1, 'H.viewport');
  must("document.getElementById('viewSeg')", 3, 'H.seg'); must("document.getElementById('legend3d')", 1, 'H.legend');
  must("window.HelmWizard", 1, 'HelmWizard');
  if (s.split('window.__').length < 10) die('builder-3d.js: window.__ hooks changed'); s = s.split('window.__').join('H.out.__');
  const rules = between(lw, "  const NO_FESTIVE = ", "  function allowsProduct(", 'layout-wizard rules');
  // the planner's country helpers sit between the type list and its aliases: not needed here
  const noCountry = between(rules, "  // UAE audit: which types a studio's country offers", '  const TYPE_ALIAS = ', 'layout-wizard country helpers');
  return `/* GENERATED from builder-3d.js + layout-wizard.js by scripts/gen-floor-view.mjs - do not edit by hand.
 * The planner's own 3D view, word for word, for the read-only layout viewer (floor-view.js): H passes in the plan and empty
 * stand-ins for everything that edits or saves. HelmFloor3D.boot(H) builds it in the viewer's own canvas.
 * Loaded only when 3D is opened. No photo render: that code is not in here. */
(function (global) {
if (!global.document) return;
const HelmWizard = (function () {
${rules.replace(noCountry, '')}  return { allowsGroup: allowsGroup };
})();
function boot(H) {
var window = global;
const store = H.store, WORLD = H.WORLD, PRICING = H.PRICING, RO = true, devicePixelRatio = H.dpr, CONG_COLORS = H.CONG_COLORS, BPUI = H.BPUI;
const toast = H.toast, congestionOf = H.congestionOf, cellFt = H.cellFt, clamp = H.clamp, getComputedStyle = H.getComputedStyle;
const snapFt = (v) => v, commit = H.noop, renderAll = H.noop, setSelection = H.setSelection, syncInspectorLive = H.noop, anyModalOpen = () => true;
/* ======== from builder-3d.js ======== */
${s}/* ======== end of builder-3d.js ======== */
}
global.HelmFloor3D = Object.freeze({ boot: boot, allowsGroup: HelmWizard.allowsGroup });
})(typeof window !== 'undefined' ? window : globalThis);
`;
}

const OUT = { 'floor-draw.js': floorDraw, 'floor-3d.js': floor3d };
const isMain = process.argv[1] && process.argv[1].endsWith('gen-floor-view.mjs');
if (isMain) {
  let bad = 0;
  for (const [f, make] of Object.entries(OUT)) {
    const next = make(), p = join(PUB, f);
    if (process.argv.includes('--check')) {
      if (!existsSync(p) || readFileSync(p, 'utf8') !== next) { console.error('  ✗ public/' + f + ' is stale - run: node scripts/gen-floor-view.mjs'); bad = 1; }
      else console.log('  ✓ ' + f + ' matches the planner');
    } else { writeFileSync(p, next); console.log('  ✓ wrote public/' + f); }
  }
  process.exit(bad);
}
