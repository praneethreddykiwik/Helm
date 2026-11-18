// R224: public-page speed (live Lighthouse audit 18 Nov 2026, AUDIT-2026-11-18/SPEED-PUBLIC.md).
//  1. /signup: the sign-up rows are shown from the FIRST paint (inline head script -> html.is-signup + CSS) - no jump
//     when setMode("signup") runs; the page script hands the form back to setMode() unchanged.
//  2. /login: store-api + supabase-js, Google sign-in and the sign-up steps load AFTER the first paint (inert
//     data-login-lazy tags, loaded in order by login-submit-guard.js, then "helm:login-ready"); no supabase preload,
//     no marketing intro overlay.
//  3. /try: the builder bundle loads after the first paint (data-try-boot, try.js), the demo starts as before.
//  4. /i/demo: publicInfo asked together with the invitation; scripts deferred; configured-origin preconnect.
//  5. /booklet: page-tours.js + tour.js only for a signed-in member preview.
//  6. landing: one hero poster for every screen. 7. one Plus Jakarta file on pricing / about / services.
//  8. /refund -> /refund-policy (308).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log('  ok  ' + name); };

const LOGIN = read('public/login.html');
const HEAD = LOGIN.slice(0, LOGIN.indexOf('</head>'));
const GUARD = read('public/login-submit-guard.js');

// the inline head script (the only inline <script> in <head>)
const headInline = [...HEAD.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

function runHead(url, store = {}) {
  assert.equal(headInline.length, 1, 'exactly one inline head script');
  const u = new URL(url, 'https://www.helm.events');
  const cls = new Set();
  const storage = { getItem: (k) => (k in store ? store[k] : null) };
  vm.runInNewContext(headInline[0], {
    location: { pathname: u.pathname, search: u.search, hash: u.hash }, URLSearchParams,
    sessionStorage: storage, localStorage: storage,
    document: { documentElement: { classList: { add: (...c) => c.forEach((x) => cls.add(x)) } } },
  });
  return [...cls].sort().join(' ');
}

t('1a head script: sign-up links paint in sign-up mode; sign-in, invites, auth returns and notices do not', () => {
  assert.equal(runHead('/signup'), 'is-signup');
  assert.equal(runHead('/signup/'), 'is-signup');
  assert.equal(runHead('/signup?mode=trial'), 'is-signup is-su-trial');
  assert.equal(runHead('/signup?trial=1'), 'is-signup is-su-trial');
  assert.equal(runHead('/signup?plan=studio&mode=paid'), 'is-signup');
  assert.equal(runHead('/login#signup'), 'is-signup');
  assert.equal(runHead('/login?signup=1'), 'is-signup');
  assert.equal(runHead('/login?mode=sales'), 'is-signup');
  assert.equal(runHead('/signup?ref=ABC123'), 'is-signup');
  for (const u of ['/login', '/login?next=/dashboard', '/login?mode=bogus', '/signup?invite=tok&k=ab', '/signup?code=xyz',
    '/signup?expired=1', '/signup?reason=signout', '/signup?confirmed=1', '/signup?reset=1', '/signup#access_token=a&refresh_token=b'])
    assert.equal(runHead(u), '', u + ' keeps the sign-in first paint');
  assert.equal(runHead('/signup', { bp_pending_invite: 'tok' }), '', 'a pending invitation keeps its own layout');
});

t('1b CSS shows exactly the rows setMode("signup") shows (and hides the sign-in-only ones)', () => {
  for (const id of ['nameField', 'pw2Row', 'agreeRow', 'pwRules', 'pwHint', 'haveAcct'])
    assert.ok(HEAD.includes('html.is-signup #' + id + '[hidden]'), id + ' shown');
  assert.match(HEAD, /html\.is-signup #pwMeter\[hidden\]\{display:flex\}/);
  assert.match(HEAD, /html\.is-signup #fullnameReq\[hidden\]\{display:inline\}/);
  assert.match(HEAD, /html\.is-signup #forgotRow,html\.is-signup #newHere,html\.is-signup #confirmHelp,html\.is-signup #agreeFoot,html\.is-signup #fullnameOpt\{display:none\}/);
  // the same rows setMode() toggles for an owner sign-up
  const page = LOGIN.slice(LOGIN.indexOf('function setMode(m)'));
  for (const id of ['pwHint', 'pwRules', 'pw2Row', 'nameField', 'pwMeter']) assert.ok(page.includes('$("#' + id + '").hidden = m!=="signup"'), id);
  for (const id of ['forgotRow', 'confirmHelp']) assert.ok(page.includes('$("#' + id + '").hidden = m==="signup"'), id);
});

t('1c the first-paint words are the words the scripts write (trial-signup.js / signup-flow.js / store-api.js)', () => {
  const span = (id, cls) => { const m = new RegExp('id="' + id + '"[^>]*>([\\s\\S]*?)</(?:h1|p|button)>').exec(LOGIN); assert.ok(m, id);
    const s = new RegExp('<span class="su-t ' + cls + '[^"]*">([^<]*)</span>').exec(m[1]); assert.ok(s, id + ' ' + cls); return s[1]; };
  // neutral /signup = trial-signup.js apply("signup") with payNow off (config.js) and DAYS from trial-facts.js
  const TF = read('public/trial-facts.js'); const DAYS = Number(/var DAYS = (\d+)/.exec(TF)[1]);
  const TS = read('public/trial-signup.js');
  assert.ok(TS.includes('setText("#formTitle", "' + span('formTitle', 'su-up') + '")'));
  assert.equal(span('formSub', 'su-up'), 'Step 1 of 4. Next you verify your e-mail, name your studio and choose how to start: contact sales, or try Helm free for ' + DAYS + ' days.');
  assert.ok(TS.includes('"Step 1 of 4. Next you verify your e-mail, name your studio and choose how to start: " + (payNow ? "pay now" : "contact sales") + ", or try Helm free for " + DAYS + " days."'));
  assert.match(read('public/config.js'), /payNow:\s*false/);
  // ?mode=trial = signup-flow.js step1Copy("trial")
  const SF = createRequire(import.meta.url)('../public/signup-flow.js');
  const c = SF.step1Copy('trial', '', DAYS);
  assert.equal(span('formTitle', 'su-tr'), c.title);
  assert.equal(span('formSub', 'su-tr'), c.sub);
  assert.equal(span('formTitle', 'su-in'), 'Welcome back');
  assert.equal(span('formSub', 'su-in'), 'Sign in with your Helm account.');
  assert.equal(span('submit', 'su-in'), 'Sign in →');
  assert.equal(span('submit', 'su-up'), 'Create account →');
  // the password checklist rows = store-api.js passwordChecks() labels, styled like attachPasswordChecklist()
  const S = read('public/store-api.js');
  const min = Number(/const PW_MIN = (\d+)/.exec(S)[1]);
  const labels = [min + ' or more characters', 'A lowercase letter', 'An uppercase letter', 'A number', 'A symbol'];
  assert.ok(S.includes('label: PW_MIN + " or more characters"'));
  for (const l of labels.slice(1)) assert.ok(S.includes('label: "' + l + '"'), l);
  assert.ok(LOGIN.includes('<ul id="pwRules" hidden>' + labels.map((l) => '<li>○ ' + l + '</li>').join('') + '</ul>'));
  assert.ok(S.includes('box.style.cssText = "list-style:none;margin:6px 0 10px;padding:0;font-size:12.5px;line-height:1.7"'));
  assert.ok(HEAD.includes('#pwRules{list-style:none;margin:6px 0 10px;padding:0;font-size:12.5px;line-height:1.7}'));
});

t('1d the page script drops the first-paint class + words before its first setMode()', () => {
  const page = LOGIN.slice(LOGIN.indexOf('document.addEventListener("helm:login-ready"'));
  const drop = page.indexOf('classList.remove("is-signup","is-su-trial")'), norm = page.indexOf('if(w) e.textContent=w.textContent');
  assert.ok(drop > 0 && norm > drop && norm < page.indexOf('function setMode('), 'drop + normalise first');
});

t('2a /login: app scripts are inert until the first paint; no supabase preload; no intro overlay', () => {
  for (const f of ['/ui-pickers.js', 'event-name.js', 'country-profile.js', 'store-api.js', 'auth-ui.js', '/auth-visual.js', '/trial-facts.js',
    '/trial-signup.js', '/plan-cards.js', '/signup-flow.js', '/referral-rules.js', '/referral-demo-gate.js', '/referral-signup.js', '/google-gis.js']) {
    const re = new RegExp('<script type="text/plain" data-login-lazy src="' + f.replace('.', '\\.') + '\\?v=\\d+"></script>');
    assert.match(LOGIN, re, f + ' lazy');
    assert.ok(!new RegExp('<script src="' + f.replace('.', '\\.') + '\\?v=').test(LOGIN), f + ' never a normal tag');
  }
  assert.ok(!/rel="preload" href="\/vendor\/supabase-js/.test(LOGIN), 'no supabase-js preload (it would start before the first paint)');
  assert.ok(!/marketing-loader\.(js|css)/.test(LOGIN), 'no 0.8 s intro overlay on the sign-in page');
  assert.match(LOGIN, /<script>\ndocument\.addEventListener\("helm:login-ready", function\(\)\{/);
  assert.ok(!/document\.addEventListener\("DOMContentLoaded"/.test(LOGIN.slice(LOGIN.indexOf('</head>'))), 'page script no longer on DOMContentLoaded');
  // config.js (may document.write the staging config) + telemetry stay normal scripts
  assert.match(LOGIN, /<script src="telemetry\.js\?v=\d+"><\/script>\n<script src="config\.js\?v=\d+"><\/script>/);
});

function guardHarness(tags) {
  const L = {}, timers = [], rafs = [], added = [], events = [];
  const mk = (src) => ({ src: null, async: true, L: {}, addEventListener(ty, fn) { this.L[ty] = fn; } });
  const doc = {
    addEventListener: (type, fn) => { (L[type] = L[type] || []).push(fn); },
    querySelectorAll: (sel) => (sel === 'link[data-lazy-css]' ? [] : tags.map((src) => ({ getAttribute: () => src, parentNode: { insertBefore: (s) => added.push(s) } }))),
    createElement: (n) => { assert.equal(n, 'script'); return mk(); },
    dispatchEvent: (ev) => { events.push(ev.type); (L[ev.type] || []).forEach((f) => f(ev)); },
  };
  class CustomEvent { constructor(type) { this.type = type; } }
  const win = { requestAnimationFrame: (f) => rafs.push(f) };
  vm.runInNewContext(GUARD, { document: doc, window: win, setTimeout: (f, ms) => timers.push([f, ms]), CustomEvent, Array });
  const fire = (type, ev) => (L[type] || []).forEach((f) => f(ev));
  return { L, timers, rafs, added, events, win, fire };
}

t('2b guard: after the first paint (no paint timing: two frames) the inert tags become ordered scripts; "helm:login-ready" once all settle; held submit replayed after', () => {
  const h = guardHarness(['/a.js?v=1', 'b.js?v=2', '/c.js?v=3']);
  let replays = 0; const form = { isConnected: true, hidden: false, requestSubmit: () => replays++ };
  h.fire('submit', { target: form, preventDefault() {}, stopImmediatePropagation() {} });
  h.fire('DOMContentLoaded', {});
  assert.equal(h.added.length, 0, 'nothing fetched before the first paint');
  assert.equal(h.rafs.length, 1); h.rafs.shift()(); assert.equal(h.rafs.length, 1); h.rafs.shift()();   // 2 frames
  const tick = h.timers.find(([, ms]) => ms === 0); assert.ok(tick, 'then a task'); tick[0]();
  assert.deepEqual(h.added.map((s) => s.src), ['/a.js?v=1', 'b.js?v=2', '/c.js?v=3'], 'document order');
  assert.ok(h.added.every((s) => s.async === false), 'ordered execution, like defer');
  let pageRan = 0; h.L['helm:login-ready'] = [() => { pageRan++; assert.equal(replays, 0, 'page handlers attach before the replay'); }];
  h.added[0].L.load(); h.added[2].L.error(); assert.equal(pageRan, 0, 'waits for every script');
  h.added[1].L.load(); assert.equal(pageRan, 1); assert.deepEqual(h.events, ['helm:login-ready']);
  assert.equal(replays, 0, 'replay waits a tick');
  h.timers.filter(([, ms]) => ms === 0).forEach(([f]) => f());
  assert.equal(replays, 1); assert.equal(h.win.HelmLoginSubmitReady, true);
  // the 1 s back-up timer is a no-op once started
  h.timers.filter(([, ms]) => ms === 1000).forEach(([f]) => f()); assert.equal(h.added.length, 3);
});

t('2c guard: a background tab (no paint, no frames) still loads via the 1 s timer; no tags = ready at once', () => {
  const run = (h, ms) => h.timers.filter(([, m]) => m === ms).forEach(([f]) => f());
  const h = guardHarness(['/x.js?v=1']); h.fire('DOMContentLoaded', {});
  run(h, 1000); run(h, 0); assert.equal(h.added.length, 1);
  const h2 = guardHarness([]); let n = 0; h2.L['helm:login-ready'] = [() => n++];
  h2.fire('DOMContentLoaded', {}); run(h2, 1000); run(h2, 0); assert.equal(n, 1);
});

t('2d guard: with paint timing, the scripts start only once "first-contentful-paint" is reported', () => {
  const L = {}, timers = [], added = []; let cb = null, observed = null, fcp = false;
  class PO { constructor(f) { cb = f; } observe(o) { observed = o; } disconnect() {} }
  PO.supportedEntryTypes = ['paint', 'largest-contentful-paint'];
  const doc = { addEventListener: (ty, fn) => { (L[ty] = L[ty] || []).push(fn); },
    querySelectorAll: (sel) => (sel === 'link[data-lazy-css]' ? [] : [{ getAttribute: () => '/a.js?v=1', parentNode: { insertBefore: (x) => added.push(x) } }]),
    createElement: () => ({ addEventListener() {} }), dispatchEvent() {} };
  const win = { PerformanceObserver: PO, performance: { getEntriesByName: () => (fcp ? [{}] : []) }, requestAnimationFrame: () => { throw new Error('no frames needed'); } };
  vm.runInNewContext(GUARD, { document: doc, window: win, setTimeout: (f, ms) => timers.push([f, ms]), Array });
  (L.DOMContentLoaded || []).forEach((f) => f({}));
  assert.equal(JSON.stringify(observed), '{"type":"paint","buffered":true}');
  cb({ getEntriesByName: () => [] }); timers.filter(([, m]) => m === 0).forEach(([f]) => f());
  assert.equal(added.length, 0, 'first-paint entry only -> still waiting');
  cb({ getEntriesByName: (n) => (n === 'first-contentful-paint' ? [{}] : []) });
  timers.filter(([, m]) => m === 0).forEach(([f]) => f());
  assert.equal(added.length, 1, 'loaded after the first contentful paint');
  // FCP already happened (script re-run late) -> start at once
  const L2 = {}, t2 = [], a2 = [];
  vm.runInNewContext(GUARD, { document: Object.assign({}, doc, { addEventListener: (ty, fn) => { (L2[ty] = L2[ty] || []).push(fn); },
    querySelectorAll: (sel) => (sel === 'link[data-lazy-css]' ? [] : [{ getAttribute: () => '/b.js', parentNode: { insertBefore: (x) => a2.push(x) } }]) }),
    window: Object.assign({}, win, { performance: { getEntriesByName: () => [{}] } }), setTimeout: (f, ms) => t2.push([f, ms]), Array });
  (L2.DOMContentLoaded || []).forEach((f) => f({})); t2.filter(([, m]) => m === 0).forEach(([f]) => f());
  assert.equal(a2.length, 1);
});

t('3 /try: the builder bundle loads after the first paint, the demo starts once it ran + the page loaded', () => {
  const TRY = read('public/try.html'), TJ = read('public/try.js'), GEN = read('scripts/gen-try.mjs');
  const body = TRY.slice(TRY.indexOf('</head>'));
  assert.ok(!/<script src=/.test(body), 'no fetched script in the body');
  for (const f of ['store-api.js', 'builder.js', 'page-tours.js', 'tour.js', 'layout-wizard.js'])
    assert.match(body, new RegExp('<script type="text/plain" data-try-boot src="' + f.replace('.', '\\.') + '\\?v=\\d+"></script>'), f);
  assert.ok(body.indexOf('data-try-boot src="store-api.js') < body.indexOf('data-try-boot src="builder.js'), 'order kept');
  assert.match(GEN, /'<script type="text\/plain" data-try-boot src="\$1"><\/script>'/);
  assert.match(TJ, /querySelectorAll\('script\[type="text\/plain"\]\[data-try-boot\]'\)/);
  assert.match(TJ, /el\.async = false;/);
  assert.match(TJ, /if \(document\.readyState === 'complete'\) startDemo\(\); else W\.addEventListener\('load', startDemo, \{ once: true \}\);/);
  assert.ok(!/W\.addEventListener\('load', function \(\) \{\n\s+if \(!loadDemo\(\)\) return;/.test(TJ), 'demo no longer started straight from window load');
  // the 3D bundle stays on demand
  for (const f of ['builder-3d', 'walkthrough']) assert.match(body, new RegExp('<script type="text/plain" data-try-lazy src="' + f + '\\.js\\?v=\\d+"></script>'));
});

t('4 /i/demo: publicInfo is asked with the invitation; scripts deferred; configured-origin preconnect right after config.js', () => {
  const INV = read('public/invite.html');
  const load = INV.slice(INV.indexOf('async function load(){'));
  const ip = load.indexOf('infoP=BPStore.sites.publicInfo(slug)'), all = load.indexOf('Promise.allSettled([BPStore.links.require(LINK), BPStore.sites.public(slug)])');
  assert.ok(ip > 0 && ip < all, 'publicInfo starts before the invitation round trip finishes');
  assert.match(load, /await showMissing\(slug, infoP\)/);
  assert.match(INV, /async function showMissing\(slug, infoP\)\{\n\s+let st=""; try\{ const i=slug\?await \(infoP\|\|BPStore\.sites\.publicInfo\(slug\)\):null;/);
  assert.equal((load.match(/BPStore\.sites\.publicInfo\(/g) || []).length, 1, 'asked once per load');
  for (const f of ['client-api.js', 'invite-placement.js', 'invite-music.js', 'invite-extras.js', 'event-name.js', 'country-profile.js'])
    assert.match(INV, new RegExp('<script src="/' + f.replace('.', '\\.') + '\\?v=\\d+" defer></script>'), f);
  assert.match(INV, /<script src="\/trial-sim\.js\?v=\d+" data-trial-sim="site" defer><\/script>/);
  assert.match(INV, /<script src="\/config\.js\?v=\d+"><\/script>\n(?:<!--[\s\S]*?-->\n)?<script src="\/db-preconnect\.js\?v=\d+"><\/script>/);
  assert.match(INV, /<script>\ndocument\.addEventListener\("DOMContentLoaded", function\(\)\{\n/);
  assert.ok(!/<link rel="(?:preconnect|dns-prefetch)" href="https:\/\/[a-z0-9]+\.supabase\.co"/.test(INV), 'no hardcoded host (staging never warms prod)');
  // db-preconnect.js: the configured origin only
  const P = read('public/db-preconnect.js'); const heads = [];
  const mk = (url) => { const h2 = []; vm.runInNewContext(P, { window: { SUPABASE_CONFIG: { url } }, document: { head: { appendChild: (l) => h2.push(l) }, querySelector: () => null,
    createElement: () => ({ a: {}, setAttribute(k, v) { this.a[k] = v; } }) } }); return h2; };
  assert.deepEqual(mk('https://abcxyz.supabase.co/').map((l) => l.a), [{ rel: 'preconnect', href: 'https://abcxyz.supabase.co', crossorigin: 'anonymous' }]);
  assert.equal(mk('https://evil.example.com').length, 0); assert.equal(mk('').length, 0); void heads;
  // Fraunces already swaps (self-hosted Google stylesheet)
  const css = read('public/fonts/g/cormorant-garamond-11547996.css');
  for (const m of css.matchAll(/@font-face \{\s*font-family: 'Fraunces';[^}]*\}/g)) assert.match(m[0], /font-display: swap;/);
});

t('5 /booklet: the in-app tour scripts only for a signed-in member preview', () => {
  const B = read('public/booklet.html');
  assert.ok(!/<script src="\/?(page-tours|tour)\.js/.test(B), 'never fetched for a client');
  assert.match(B, /<script type="text\/plain" data-member-tour src="\/page-tours\.js\?v=\d+"><\/script>\n<script type="text\/plain" data-member-tour src="\/tour\.js\?v=\d+"><\/script>/);
  assert.ok(B.indexOf('/booklet-member-tour.js?v=') > B.indexOf('/client-api.js?v='), 'after client-api.js (full-mode flag)');
  const M = read('public/booklet-member-tour.js');
  const run = (full) => { const added = []; vm.runInNewContext(M, { window: { __HELM_CLIENT_FULL__: full }, document: { readyState: 'interactive',
    querySelectorAll: () => ['/page-tours.js?v=1', '/tour.js?v=1'].map((s) => ({ getAttribute: () => s, parentNode: { insertBefore: (x) => added.push(x) } })),
    createElement: () => ({}) } }); return added; };
  assert.equal(run(false).length, 0);
  assert.deepEqual(run(true).map((s) => [s.src, s.async]), [['/page-tours.js?v=1', false], ['/tour.js?v=1', false]]);
});

t('6 landing: one hero poster for every screen (the one the markup + preload already fetch)', () => {
  const J = read('public/home.js'), I = read('public/index.html');
  assert.match(J, /var heroPosterSrc = '\/home-assets\/hero-poster\.webp';/);
  assert.ok(!/'\/home-assets\/hero-hq-poster/.test(J), 'the wide-screen poster is no longer swapped in');
  assert.match(I, /poster="\/home-assets\/hero-poster\.webp"/);
  assert.match(I, /<link rel="preload" href="\/home-assets\/hero-poster\.webp" as="image"/);
});

t('7 pricing / about / services: Plus Jakarta from one set of files (public-v2.css, now with 800)', () => {
  for (const f of ['pricing.html', 'about.html', 'services.html']) {
    const H = read('public/' + f);
    assert.ok(!/fonts\/g\/plus-jakarta-sans-/.test(H), f + ': no second Plus Jakarta stylesheet');
    assert.match(H, /<link rel="stylesheet" href="\/public-v2\.css\?v=\d+">/);
  }
  const V = read('public/public-v2.css');
  for (const w of [400, 500, 600, 700, 800]) {
    const faces = [...V.matchAll(new RegExp("@font-face\\{font-family:'Plus Jakarta Sans';font-style:normal;font-weight:" + w + ";[^}]*\\}", 'g'))].map((m) => m[0]);
    assert.equal(faces.length, 4, w + ': 4 subsets');
    for (const fc of faces) assert.match(fc, /src:url\(\/fonts\/plus-jakarta-sans-[a-z-]+\.woff2\?v=1\)/);
  }
});

t('8 /refund is a permanent (308) redirect to /refund-policy', () => {
  const V = JSON.parse(read('vercel.json'));
  const r = V.redirects.find((x) => x.source === '/refund');
  assert.ok(r && r.destination === '/refund-policy' && r.permanent === true && !r.statusCode);
});

console.log('r224-public-speed: ALL PASS (' + passed + ')');
