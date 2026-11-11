// R146: faster /login first paint (Lighthouse LCP budget 3.5 s) without changing what the page does.
//  1. The stylesheets only the sign-up / plan / onboarding steps use (ui-pickers, trial-terms, plan-cards,
//     referral-signup) are <link media="print" data-lazy-css>: they download early but no longer hold the first paint.
//  2. login-submit-guard.js (a normal <head> script) switches them on at DOMContentLoaded, in a listener registered
//     BEFORE login.html's page script - so every step that needs them still has its styles when it is shown.
//  3. console-warning.js (a console message only) is deferred. marketing-theme.js is deferred too: the attributes it
//     sets (data-pt / data-hb-theme = emerald, data-theme = light, data-mk-lock) are written in the <html> tag itself,
//     so the first paint is the same green light theme (color-scheme:light comes from public-v2.css html[data-pt]).
//  4. What the first paint really needs stays blocking, in the same order: trusted-types.js, auth-handoff.js,
//     login-submit-guard.js, theme.css, public-v2.css, marketing-loader.css/.js; config.js +
//     telemetry.js stay normal scripts before the deferred app scripts (config.js may document.write staging).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const LOGIN = read('public/login.html');
const HEAD = LOGIN.slice(0, LOGIN.indexOf('</head>'));
const GUARD = read('public/login-submit-guard.js');
let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log('  ok  ' + name); };

const LAZY = ['ui-pickers.css', 'trial-terms.css', 'plan-cards.css', 'referral-signup.css'];

t('1 sign-up-only stylesheets do not block the first paint (media="print" data-lazy-css, cache-bust kept)', () => {
  for (const f of LAZY) {
    const re = new RegExp('<link rel="stylesheet" href="/' + f.replace('.', '\\.') + '\\?v=\\d+"( [^>]*)?>', 'g');
    const tags = [...LOGIN.matchAll(re)];
    assert.equal(tags.length, 1, f + ' linked exactly once');
    assert.equal(tags[0][1], ' media="print" data-lazy-css', f + ' is non-blocking + marked lazy');
    assert.ok(tags[0].index < HEAD.length, f + ' still in <head> (downloads early)');
  }
  // the marker is only ever used together with media="print"
  const marked = [...LOGIN.matchAll(/<link [^>]*data-lazy-css[^>]*>/g)].map((m) => m[0]);
  assert.equal(marked.length, LAZY.length);
  for (const m of marked) assert.match(m, / media="print" data-lazy-css>$/);
});

t('2 the first-paint stylesheets stay render-blocking', () => {
  for (const f of ['theme.css', '/public-v2.css', '/marketing-loader.css']) {
    const re = new RegExp('<link rel="stylesheet" href="' + f.replace('.', '\\.') + '\\?v=\\d+">');
    assert.match(HEAD, re, f + ' is a normal stylesheet in <head>');
  }
});

t('3 login-submit-guard.js switches the lazy sheets on at DOMContentLoaded, before the page script', () => {
  const L = {};
  const links = LAZY.map(() => ({ media: 'print' }));
  const doc = {
    addEventListener: (type, fn) => { (L[type] = L[type] || []).push(fn); },
    querySelectorAll: (sel) => { assert.equal(sel, 'link[data-lazy-css]'); return links; },
  };
  vm.runInNewContext(GUARD, { document: doc, window: {}, setTimeout: () => {} });
  assert.equal(L.DOMContentLoaded.length, 2, 'lazy-css + replay listeners');
  L.DOMContentLoaded[0]({});
  assert.deepEqual(links.map((l) => l.media), LAZY.map(() => 'all'), 'every lazy sheet now applies');
  // a document without querySelectorAll (old harnesses) never throws
  const L2 = {};
  vm.runInNewContext(GUARD, { document: { addEventListener: (ty, fn) => { (L2[ty] = L2[ty] || []).push(fn); } }, window: {}, setTimeout: () => {} });
  assert.doesNotThrow(() => L2.DOMContentLoaded.forEach((f) => f({})));
  // listener order = registration order: the guard (in <head>) registers before login.html's page script (in <body>)
  const g = LOGIN.indexOf('<script src="/login-submit-guard.js?v=2"></script>');
  const page = LOGIN.indexOf('<script>\ndocument.addEventListener("DOMContentLoaded"');
  assert.ok(g > 0 && g < HEAD.length && page > g, 'guard v=2 in <head>, page script later');
});

t('4 console-warning.js + marketing-theme.js deferred (theme attrs static); first-paint scripts stay blocking, same order', () => {
  assert.match(HEAD, /<script src="\/console-warning\.js\?v=\d+" defer><\/script>/);
  assert.match(HEAD, /<script src="\/marketing-theme\.js\?v=\d+" defer><\/script>/);
  assert.match(LOGIN, /^<!doctype html>\n<html lang="en" data-theme="light" data-pt="emerald" data-hb-theme="emerald" data-mk-lock>/, 'green light theme from the first paint');
  const mt = read('public/marketing-theme.js');
  for (const a of ["'data-pt', 'emerald'", "'data-hb-theme', 'emerald'", "'data-theme', 'light'", "'data-mk-lock', ''"]) assert.ok(mt.includes(a), 'static attrs match marketing-theme.js: ' + a);
  assert.match(read('public/public-v2.css'), /html\[data-pt\] \{[^}]*color-scheme:light; \}/);
  const blocking = ['/trusted-types.js', '/auth-handoff.js', '/login-submit-guard.js', '/marketing-loader.js'];
  let at = -1;
  for (const f of blocking) {
    const m = new RegExp('<script src="' + f.replace('.', '\\.') + '\\?v=\\d+"></script>').exec(HEAD);
    assert.ok(m, f + ' is a normal (blocking) <head> script');
    assert.ok(m.index > at, f + ' keeps its order'); at = m.index;
  }
  assert.match(LOGIN, /<script src="telemetry\.js\?v=\d+"><\/script>\n<script src="config\.js\?v=\d+"><\/script>/);
  assert.ok(LOGIN.indexOf('<script src="config.js') < LOGIN.indexOf('<script src="event-name.js'), 'config.js before the app scripts');
  for (const f of ['store-api.js', 'auth-ui.js', 'google-gis.js', 'signup-flow.js', 'referral-signup.js', 'plan-cards.js', 'trial-signup.js']) {
    assert.match(LOGIN, new RegExp('<script src="/?' + f.replace('.', '\\.') + '\\?v=\\d+" defer></script>'), f + ' deferred');
  }
});

console.log('r146-login-lcp: ALL PASS (' + passed + ')');
