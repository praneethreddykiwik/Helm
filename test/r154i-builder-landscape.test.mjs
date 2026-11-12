// R154i: the floor builder on a phone held sideways + the portrait "turn your phone" card.
// Static guards (the live checks are in tests/e2e/responsive/builder-landscape.spec.mjs):
//  - every landscape layout rule sits inside ONE phone-only media query (landscape + max-height:500px + coarse
//    pointer), so desktops / laptops / tablets are untouched; the /try sandbox is excluded
//  - builder.js uses the same query for its drawers and skips the auto tour there
//  - builder-orient.js: card only in portrait on small touch screens, "Continue anyway" in sessionStorage behind
//    try/catch, orientation lock only after a tap and only where supported, DOM API only (no innerHTML)
//  - builder.html: viewport-fit=cover (safe areas), stylesheet + script wired with cache-busts; capture.html /
//    try.html regenerated; the builder tour knows the phone drawer buttons
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const read = (p) => readFileSync(new URL('../public/' + p, import.meta.url), 'utf8');
const css = read('builder-landscape.css');
const js = read('builder-orient.js');
const html = read('builder.html');
const builder = read('builder.js');
const b3d = read('builder-3d.js');
const LAND = '(orientation:landscape) and (max-height:500px) and (pointer:coarse)';

// ---- CSS: scoped ----
const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
const outside = [];   // top-level rules (not inside @media) - only the safe-area body padding + the portrait card may live there
{
  let depth = 0, buf = '', inMedia = 0;
  for (const ch of noComments) {
    buf += ch;
    if (ch === '{') { if (depth === 0 && /@media/.test(buf)) inMedia = 1; else if (depth === 0) outside.push(buf.trim()); depth++; buf = ''; }
    else if (ch === '}') { depth--; if (depth === 0) { inMedia = 0; } buf = ''; }
  }
  void inMedia;
}
for (const sel of outside) {
  assert.ok(/^(html:not\(\.helm-sandbox\) body|\.orient-|@keyframes)/.test(sel), 'only the safe-area padding and the portrait card are global: ' + sel);
}
assert.match(noComments, /html:not\(\.helm-sandbox\) body\{padding:env\(safe-area-inset-top,0px\) env\(safe-area-inset-right,0px\) 0 env\(safe-area-inset-left,0px\)\}/, 'safe-area padding (0 on desktop)');
const medias = [...noComments.matchAll(/@media ([^{]+)\{/g)].map((m) => m[1].trim());
for (const m of medias) {
  assert.ok(m.startsWith(LAND) || m === '(prefers-reduced-motion:reduce)', 'every layout media query is the phone-landscape one: ' + m);
}
assert.ok(medias.filter((m) => m.startsWith(LAND)).length >= 1, 'phone-landscape block exists');
const splitTop = (sel) => { const out = []; let d = 0, cur = ''; for (const ch of sel) { if (ch === '(' || ch === '[') d++; else if (ch === ')' || ch === ']') d--; if (ch === ',' && d === 0) { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out; };
// every selector inside the landscape blocks is scoped away from the /try sandbox
const landBody = noComments.slice(noComments.indexOf('@media ' + LAND));
for (const rule of landBody.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
  const sel = rule[1].trim(); if (sel.startsWith('@media')) continue;
  for (const part of splitTop(sel)) assert.match(part.trim(), /^html:not\(\.helm-sandbox\)/, 'scoped to the app builder: ' + part);
}
assert.match(landBody, /height:100dvh/, '100dvh, not 100vh');
assert.doesNotMatch(css, /100vh/, 'no 100vh in the landscape sheet');
assert.match(landBody, /aside\.left\.open,html:not\(\.helm-sandbox\) aside\.right\.open\{transform:none;visibility:visible/, 'drawers slide over');
assert.match(landBody, /touch-action:pan-x pan-y/, 'the floor pans natively, the page does not pinch-zoom');
assert.match(landBody, /:is\(\.obj,\[data-handle\],\[data-margin\]\)\{touch-action:none\}/, 'objects / handles drag by touch');
assert.match(landBody, /safe-area-inset-bottom/, 'home-bar inset respected');
assert.match(landBody, /\.modal \.sheet-body\{[^}]*overflow:auto/, 'dialogs scroll inside');
assert.match(landBody, /header :is\(select,\.tbtn,\.nameinput,\.capmeter,\.capinput\)\{height:40px;min-height:40px/, '40px header touch targets');
assert.match(landBody, /header \.seg button\{height:40px;min-height:40px/, '40px segmented buttons');

// ---- builder.js: same query, guarded ----
assert.match(builder, /const DRAWER_MQ = window\.matchMedia\('\(max-width:720px\), \(orientation:landscape\) and \(max-height:500px\) and \(pointer:coarse\)'\);/, 'drawers also for a sideways phone');
assert.match(builder, /matchMedia\('\(max-width:720px\), \(orientation:landscape\) and \(max-height:500px\) and \(pointer:coarse\)'\)\.matches\) return;/, 'no auto tour on a sideways phone');
assert.match(b3d, /transform\.setSize\(\(window\.matchMedia && matchMedia\('\(pointer:coarse\)'\)\.matches\) \? 1\.5 : 1\.1\)/, 'bigger 3D gizmo for a finger, desktop unchanged');

// ---- builder-orient.js ----
assert.match(js, /var PORTRAIT_Q = '\(orientation:portrait\) and \(pointer:coarse\) and \(max-width:599px\)';/, 'card only on small touch screens held upright');
assert.match(js, /var LAND_Q = '\(orientation:landscape\) and \(max-height:500px\) and \(pointer:coarse\)';/, 'same landscape query as the CSS');
assert.match(js, /try \{ dismissed = sessionStorage\.getItem\(KEY\) === '1'; \} catch \(_\) \{ dismissed = false; \}/, 'read in try/catch');
assert.match(js, /try \{ sessionStorage\.setItem\(KEY, '1'\); \} catch \(_\) \{\}/, 'write in try/catch');
assert.match(js, /helm-sandbox[\s\S]*helm-capture[\s\S]*return;/, 'no-op in the sandbox and the picture host');
assert.match(js, /lock\.addEventListener\('click'/, 'orientation lock only after a tap');
assert.match(js, /typeof screen\.orientation\.lock === 'function' && html\.requestFullscreen/, 'lock button only where supported');
assert.match(js, /lock\.hidden = !canLock\(\)/, 'no lock button where unsupported (iPhone)');
assert.match(js, /Continue anyway/, 'Continue anyway');
assert.match(js, /Turn your phone sideways for the best view/, 'the card text');
assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, 'DOM API only');
assert.match(js, /addEventListener\('touchmove'[\s\S]*\{ passive: false \}/, 'pinch can stop the page from zooming');
assert.match(js, /if \(!\(landMq\.matches \|\| phoneMq\.matches\) \|\| e\.touches\.length !== 2\) return;/, 'two-finger zoom only on a phone (R164: upright too)');
assert.match(js, /if \(typing\(\)\) return;/, 'a keyboard squeezing the screen is not a rotation');

// ---- wiring ----
assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-visual">/, 'safe areas + stable layout with the keyboard');
assert.match(html, /<link rel="stylesheet" href="\/builder-landscape\.css\?v=1">/, 'stylesheet wired');
assert.ok(html.indexOf('builder-landscape.css') > html.indexOf('builder-v2.css'), 'landscape sheet loads after builder-v2.css');
assert.match(html, /<script src="builder-orient\.js\?v=2"><\/script>/, 'script wired');
assert.ok(html.indexOf('builder-orient.js') > html.indexOf('builder.js?v='), 'orient script after builder.js (uses its globals)');
assert.match(html, /builder\.js\?v=(9[1-9]|\d{3})\b/, 'builder.js cache-bust bumped');
assert.match(html, /builder-3d\.js\?v=34/, 'builder-3d.js cache-bust bumped');
assert.match(html, /page-tours\.js\?v=(3[1-9]|[4-9]\d|\d{3})\b/, 'page-tours.js cache-bust bumped (31 or later)');
const capture = read('capture.html');
assert.match(capture, /builder-landscape\.css\?v=1/, 'capture.html regenerated');
assert.match(read('try.html'), /builder-orient\.js\?v=\d+/, 'try.html regenerated (the script no-ops there)');
const tours = read('page-tours.js');
assert.match(tours, /\{ sel: \["#toolbox", "#toolsToggle"(, "#bimTools")?\], side: "right", title: "Drag any asset"/, 'toolbox step falls back to the phone Tools button');
assert.match(tours, /\{ sel: \["#rightPanel", "#inspToggle"(, "#bimInsp")?\], side: "left", title: "Price & inspector"/, 'inspector step falls back to the phone Inspector button');
console.log('r154i-builder-landscape: ok');
