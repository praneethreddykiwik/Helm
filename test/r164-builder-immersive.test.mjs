// R164: the floor builder on a phone (upright or sideways) as a full-screen editor with floating controls, a real
// full-screen mode (whole page; app-level immersive fallback on iPhone Safari) with a clear Exit, the app's bottom tab
// bar folded away in the builder, and Home "Continue quotes" showing 3 (was 5).
// Static guards; the live checks are in tests/e2e/responsive/builder-immersive.spec.mjs (+ builder-landscape.spec.mjs).
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const read = (p) => readFileSync(new URL('../public/' + p, import.meta.url), 'utf8');
const css = read('builder-immersive.css');
const js = read('builder-immersive.js');
const fs = read('fullscreen.js');
const orient = read('builder-orient.js');
const html = read('builder.html');
const builder = read('builder.js');
const tours = read('page-tours.js');
const PHONE = '(pointer:coarse) and (orientation:landscape) and (max-height:500px), (pointer:coarse) and (orientation:portrait) and (max-width:599px)';

// ---- one phone query, everywhere ----
assert.ok(js.includes("var PHONE_Q = '" + PHONE + "';"), 'builder-immersive.js uses the phone query');
assert.ok(fs.includes("const PHONE_Q = '" + PHONE + "';"), 'fullscreen.js uses the same phone query');
assert.ok(orient.includes("var PHONE_Q = '" + PHONE + "';"), 'builder-orient.js uses the same phone query');
assert.ok(css.includes('@media ' + PHONE + '{'), 'builder-immersive.css: the phone block');

// ---- CSS: everything that changes the layout is inside a phone-only query, scoped away from the /try sandbox ----
const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
const top = []; { let d = 0, buf = ''; for (const ch of noComments) { buf += ch; if (ch === '{') { if (d === 0) top.push(buf.slice(0, -1).trim()); d++; buf = ''; } else if (ch === '}') { d--; buf = ''; } } }
for (const sel of top) {
  if (sel.startsWith('@media')) {
    const q = sel.slice(7).trim();
    assert.ok(q.startsWith('(pointer:coarse) and (orientation:') || q === '(prefers-reduced-motion:reduce)', 'phone-only media query: ' + q);
    for (const part of q.split(',')) if (!/prefers-reduced-motion/.test(part)) assert.match(part, /\(pointer:coarse\)[\s\S]*(max-height:500px|max-width:(599|374)px)/, 'touch + small: ' + part);
  } else {
    // outside a query only: hide the phone controls, and make the canvas buttons tap-safe (no double-tap page zoom)
    assert.ok(/^\.bim-cluster,\.bim-rail,\.bim-navh,\.bim-menux$/.test(sel) || /^\.fabstack button,\.fs-bar button,\.navpad button$/.test(sel), 'global rule allowed: ' + sel);
  }
}
assert.match(noComments, /\.fabstack button,\.fs-bar button,\.navpad button\{touch-action:manipulation\}/, 'zoom / fullscreen buttons: a second quick tap is a tap, not a page zoom');
const inMedia = noComments.slice(noComments.indexOf('@media'));
const splitTop = (sel) => { const out = []; let d = 0, cur = ''; for (const ch of sel) { if (ch === '(' || ch === '[') d++; else if (ch === ')' || ch === ']') d--; if (ch === ',' && d === 0) { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out; };
for (const rule of inMedia.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
  const sel = rule[1].trim(); if (sel.startsWith('@media')) continue;
  for (const part of splitTop(sel)) assert.match(part.trim(), /^html(\.[\w-]+)?:not\(\.helm-sandbox\)/, 'scoped to the app builder: ' + part);
}
assert.doesNotMatch(css, /100vh/, '100dvh, not 100vh');
assert.match(css, /body>header\{position:fixed;[^}]*transform:translateY\(calc\(-100% - 16px\)\);visibility:hidden/, 'the top bar is folded away on a phone');
assert.match(css, /html\.bim-menu:not\(\.helm-sandbox\) body>header\{transform:none;visibility:visible/, 'More opens it as a sheet');
assert.match(css, /\.bim-rail\{position:fixed;[^}]*left:calc\(8px \+ env\(safe-area-inset-left,0px\)\);[^}]*flex-direction:column/, '2D / 3D / Walk stacked on the left');
assert.match(css, /\.fabstack\{\s*position:fixed;left:auto;right:calc\(8px \+ env\(safe-area-inset-right,0px\)\);[^}]*flex-direction:column/, 'zoom stacked on the right');
assert.match(css, /#zoomIn\{order:1\}[\s\S]*#zoomOut\{order:3\}[\s\S]*#zoomFit\{order:4/, 'zoom in on top, then out, then fit');
assert.match(css, /html:not\(\.helm-sandbox\):not\(\.bim-nav-open\) body \.hmn-bar\{display:none!important\}/, 'bottom tab bar folded away in the builder');
assert.match(css, /body\.hmn-on\{padding-bottom:0\}/, 'and its padding');
assert.match(css, /body\.fs-on #leftPanel\.open,html:not\(\.helm-sandbox\) body\.fs-on #rightPanel\.open\{visibility:visible\}/, 'drawers work in full screen');
assert.match(css, /body\.fs-on \.hmn-bar/, 'no app bar in full screen');
assert.match(css, /\.bim-b\{[^}]*min-width:44px;height:44px/, '44px floating buttons');
assert.match(css, /\.zoombar button\{width:44px;min-width:44px;height:44px;min-height:44px/, '44px zoom buttons');
assert.match(css, /safe-area-inset-top/); assert.match(css, /safe-area-inset-bottom/); assert.match(css, /safe-area-inset-left/); assert.match(css, /safe-area-inset-right/);

// ---- JS: proxies to the real controls, no-op in the sandbox / picture host, DOM API only ----
assert.match(js, /helm-sandbox[\s\S]*helm-capture[\s\S]*return;/, 'no-op in the sandbox and the picture host');
assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/, 'DOM API only');
assert.match(js, /bBack\.addEventListener\('click', function \(\) \{ press\('header \.brand'\); \}\);/, 'Back = the logo link (unsaved-change guard + builder-back.js URL)');
assert.match(js, /bSave\.addEventListener\('click', function \(\) \{ press\('#saveBtn'\); \}\);/, 'Save = the real Save');
assert.match(js, /press\('#toolsToggle'\)/); assert.match(js, /press\('#inspToggle'\)/);
assert.match(js, /press\('#viewSeg \[data-v="' \+ b\.getAttribute\('data-v'\) \+ '"\]'\)/, '2D / 3D = the real view switch');
assert.match(js, /HelmFullscreen\._ui; if \(u && u\.exit\) u\.exit\(\);/, 'Exit leaves full screen');
assert.match(js, /bExit\.hidden = !on; bBack\.hidden = on;/, 'Back turns into Exit in full screen');
assert.match(js, /try \{ navOpen = sessionStorage\.getItem\(NAV_KEY\) === '1'; \} catch \(_\) \{ navOpen = false; \}/, 'storage read in try/catch');
assert.match(js, /try \{ sessionStorage\.setItem\(NAV_KEY, on \? '1' : '0'\); \} catch \(_\) \{\}/, 'storage write in try/catch');
assert.match(js, /'bim-cluster bim-tl bim-keep'/); assert.match(builder, /'#leftPanel,#rightPanel,\.drawer-btns,\.bim-keep,\.modal,\.bpui-overlay,\[data-bpui\]'/, 'tapping a floating button does not count as an outside tap');

// ---- full screen ----
assert.match(fs, /target = onPhone\(\) \? doc\.documentElement : vp;/, 'phones: the whole page goes full screen (drawers + floating controls included)');
assert.match(fs, /F\.request\(target\)/);
assert.match(fs, /vp\.classList\.toggle\('fs-pseudo', on && pseudo && !whole\)/, 'desktop pseudo-fullscreen unchanged');
assert.match(fs, /classList\.toggle\('fs-phone', on && whole\)/, 'app-level immersive class on a phone');
assert.match(orient, /if \(!\(landMq\.matches \|\| phoneMq\.matches\) \|\| e\.touches\.length !== 2\) return;/, 'pinch zoom on a phone held either way');

// ---- wiring ----
assert.match(html, /<link rel="stylesheet" href="\/builder-immersive\.css\?v=1">/);
assert.ok(html.indexOf('builder-immersive.css') > html.indexOf('builder-landscape.css'), 'loads after the landscape sheet');
assert.match(html, /<script src="builder-immersive\.js\?v=1"><\/script>/);
assert.ok(html.indexOf('builder-immersive.js') > html.indexOf('fullscreen.js') && html.indexOf('builder-immersive.js') > html.indexOf('builder.js?v='), 'after fullscreen.js and builder.js');
assert.match(html, /builder\.js\?v=92/); assert.match(html, /fullscreen\.js\?v=6/); assert.match(html, /builder-orient\.js\?v=2/); assert.match(html, /page-tours\.js\?v=34/);
assert.match(read('capture.html'), /builder-immersive\.css\?v=1/, 'capture.html regenerated');
assert.match(read('try.html'), /builder-immersive\.js\?v=1/, 'try.html regenerated (the script no-ops there)');
assert.match(tours, /\{ sel: \["header \.brand", "#bimBack"\]/); assert.match(tours, /\{ sel: \["#viewSeg", "#bimRail"\]/); assert.match(tours, /\{ sel: \["#saveBtn", "#bimSave"\]/);
assert.match(tours, /\{ sel: "#bimMore"/); assert.match(tours, /\{ sel: "#bimNav"/);

// ---- B) Home "Continue quotes": 3 ----
const fr = read('flow-resume.js');
assert.match(fr, /var HOME_MAX = 3;/, 'Home lists up to 3');
for (const f of ['dashboard.html', 'event.html', 'discovery.html', 'flow.html', 'quotes.html', 'proposal.html']) assert.match(read(f), /flow-resume\.js\?v=9/, f + ' cache-bust');
console.log('r164-builder-immersive: ok');
