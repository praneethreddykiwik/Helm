// R225: Tasks & Crew, Event-day monitor and crew shifts follow the studio's colour theme (owner: "in other themes, some places
// it's showing green - show the respective colour; black is good").
//   1 ops-board.css: the green palette lives only in the .tc token block (= Emerald, unchanged); no rule hard-codes an accent green
//   2 every non-Emerald theme maps the --tc-* accent / tint tokens to the theme's own tokens; --tc-black is never remapped
//   3 status colours (safe / warn / bad) keep their meaning; monitor.css and crew-shifts.css follow the same pattern
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); } };
const HTML = read('public/ops.html'), OPS = read('public/ops-board.css'), MON = read('public/monitor.css'), CS = read('public/crew-shifts.css');
const THEMED = 'html[data-shell="b"][data-hb-theme]:not([data-hb-theme="emerald"])';
// the Emerald accent / tint greens (accent, hover, soft, accent text, now-row, tinted panels, lines, ink)
const GREENS = /#(047857|10a37a|065f46|e3f4ed|036b4d|18a558|ecf8f1|f4f8f6|f7faf9|e0eae5|edf3f0|0b2a22|2f4a42|566b64|eef1f0|46544e|9fd3bd)\b|rgba\(11,42,34/i;
const block = (css, sel) => { const i = css.indexOf(sel); assert.ok(i >= 0, 'missing ' + sel); return css.slice(i, css.indexOf('}', i) + 1); };

t('ops-board.css: the Emerald palette is defined once, in the .tc token block, with its exact values', () => {
  const tok = block(OPS, '.tc,.tc-layer{');
  for (const v of ['--tc-bg:#f4f8f6', '--tc-acc:#047857', '--tc-acc-soft:#e3f4ed', '--tc-acc-text:#036b4d', '--tc-line:#e0eae5', '--tc-black:#111', '--tc-now-bg:#ecf8f1', '--tc-now-bar:#18a558'])
    assert.ok(tok.includes(v), 'token block keeps ' + v);
  const rest = OPS.replace(tok, '');
  const m = rest.match(GREENS);
  assert.equal(m, null, 'hard-coded accent green outside the token block: ' + (m && m[0]));
});
t('ops-board.css: non-Emerald themes remap the accent + tint tokens to the theme, never the black', () => {
  const ov = block(OPS, THEMED + ' :is(.tc,.tc-layer){');
  for (const k of ['--tc-bg:', '--tc-panel:', '--tc-ink-3:', '--tc-line:', '--tc-line-2:', '--tc-acc:var(--accent', '--tc-acc-hover:', '--tc-acc-soft:var(--accent-soft', '--tc-acc-text:', '--tc-now-bg:', '--tc-now-bar:var(--accent', '--tc-elev-lg:'])
    assert.ok(ov.includes(k), 'override sets ' + k);
  assert.ok(!/--tc-black|--tc-safe|--tc-warn|--tc-bad/.test(ov), 'black and status colours are not themed');
  assert.ok(!GREENS.test(ov), 'no green inside the override');
});
t('ops-board.css: the R222 rows use tokens (run-sheet "now" row, wrap-up OK, step on, picker selected)', () => {
  assert.match(OPS, /\.tc-run-row\.now\{background:var\(--tc-now-bg\);box-shadow:inset 3px 0 0 var\(--tc-now-bar\)\}/);
  assert.match(OPS, /\.tc-wrap\.ok\{border-color:var\(--tc-safe-line\)\}/);
  assert.match(OPS, /\.tc-step\.on\{background:var\(--tc-acc\)/);
  assert.match(OPS, /\.tc-opt\[aria-pressed="true"\]\{background:var\(--tc-acc-soft\);border-color:var\(--tc-acc\);color:var\(--tc-acc-text\)\}/);
  assert.match(OPS, /\.tc-phase-row \.tc-seg\[aria-pressed="true"\]\{background:var\(--tc-black\)/, 'selected Before / On the day stays black');
});
t('monitor.css + crew-shifts.css: Emerald fallbacks kept, other themes remapped, status green kept', () => {
  const mov = block(MON, THEMED + ' .mon-body{');
  for (const k of ['--m-bg:', '--m-ink-3:', '--m-line:', '--m-acc-soft:', '--m-acc-hi:']) assert.ok(mov.includes(k), 'monitor override sets ' + k);
  assert.match(MON, /linear-gradient\(90deg,var\(--m-acc-hi,#10a37a\),var\(--m-acc\)\)/);
  const cov = block(CS, THEMED + '{');
  for (const k of ['--cs-acc-soft:', '--cs-acc-text:', '--cs-acc-line:']) assert.ok(cov.includes(k), 'crew-shifts override sets ' + k);
  assert.match(CS, /\.cs-cell\.work\{background:var\(--cs-acc-soft,#e3f4ed\);border-color:var\(--cs-acc-line,#9fd3bd\);color:var\(--cs-acc-text,#036b4d\)\}/);
  assert.match(CS, /\.cs-pill\.filled\{background:#e7f6ee;color:#0f7a43\}/, 'filled = status green, unchanged');
});

t('Crew notes & photos sits ABOVE the task drawer (owner: dialog + photo looked dimmed) and a photo opens big', () => {
  // the shell's dialog layer html[data-shell="b"] .lmodal{z-index:1100} must not win: our rule is more specific and above the scrim
  assert.match(OPS, /\.lmodal,html\[data-shell\] body \.lmodal\{z-index:2200\}/);
  const scrim = +OPS.match(/\.tc-scrim\{[^}]*z-index:(\d+)/)[1], drawer = +OPS.match(/\.tc-drawer\{[^}]*z-index:(\d+)/)[1];
  assert.ok(2200 > scrim && 2200 > drawer, 'dialog above scrim ' + scrim + ' and drawer ' + drawer);
  assert.match(OPS, /html\[data-shell\] body \.lmodal\.evlight\{z-index:2300\}/);
  assert.match(HTML, /<div class="lmodal evlight" id="evLight" hidden role="dialog" aria-modal="true"/);
  assert.match(HTML, /\$\("#ev_body"\)\.addEventListener\("click",e=>\{ const a=e\.target\.closest\("\.evgal a\[href\]"\)/);
  assert.match(HTML, /function closeEvidence\(\)\{ closePhoto\(\);/);
  assert.match(HTML, /window\.addEventListener\("keydown",e=>\{ if\(e\.key!=="Escape"\) return;/, 'Escape closes the top layer first');
});

console.log(`r225-theme-colours: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
