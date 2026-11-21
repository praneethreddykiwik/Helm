// R243 - Phase 11 (devices, offline, formats) + Vercel Web Analytics on the public pages only.
//   A. site-analytics.js: public pages only, query / hash stripped, other pages + hosts dropped, same-origin script,
//      the CSP needs nothing new ('self'), never on a signed-in / client / crew page
//   B1. crew-offline.js (OPS-03): saved once per press, sent in order, a network failure keeps the rest, a refusal
//      removes the item, an old check-in is never sent, the raw link token is never a storage key; work.html +
//      crew-self.js wiring
//   B2. browser-check.js (DEV-01 / DEV-03): feature checks, storage check, on every page except the hidden capture host
//   B3. formats: phone read-back (OPS-05), "20 Oct 2026" in the e-mails + crew pages (LOC-04), money style per currency
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); } };
const PAGES = readdirSync(new URL('../public/', import.meta.url)).filter((f) => f.endsWith('.html'));

// ---------------- A. analytics ----------------
const PUBLIC = ['index', 'pricing', 'about', 'services', 'contact-sales', 'demo', 'try', 'login', 'terms', 'privacy', 'cookie-policy',
  'acceptable-use', 'accessibility', 'ai-notice', 'copyright', 'data-deletion', 'dpa', 'grievance', 'refund-policy', 'referral-terms',
  'security', 'sla', 'subprocessors'].map((p) => p + '.html');
function loadSA(href) {
  const u = new URL(href), added = [];
  const win = { location: { href: u.href, origin: u.origin, hostname: u.hostname } };
  const doc = { createElement: () => ({}), head: { appendChild: (x) => added.push(x) }, documentElement: {} };
  vm.runInNewContext(read('public/site-analytics.js'), { window: win, document: doc, URL });
  return { win, added };
}

await t('A1 analytics tag only on the public pages; never on an app, client or crew link page', () => {
  const tagged = PAGES.filter((f) => /site-analytics\.js\?v=\d+/.test(read('public/' + f))).sort();
  assert.deepEqual(tagged, PUBLIC.slice().sort());
  for (const f of ['work.html', 'approve.html', 'booklet.html', 'portal.html', 'invite.html', 'proposal-view.html', 'dashboard.html',
    'reset-password.html', 'unsubscribe.html', 'enquiry.html', 'delivery.html', 'vendor-request.html', 'capture.html', 'builder.html'])
    assert.ok(!/site-analytics|_vercel\/insights/.test(read('public/' + f)), f);
  assert.match(read('scripts/gen-try.mjs'), /site-analytics\.js\?v=' \+ SITE_ANALYTICS_V/);
});
await t('A2 beforeSend: this origin + an allowlisted path only, query and #hash removed', () => {
  const { win } = loadSA('https://www.helm.events/pricing?plan=pro#x');
  const S = win.HelmSiteAnalytics;
  assert.equal(S.beforeSend({ type: 'pageview', url: 'https://www.helm.events/login?invite=abc&token=zz#access_token=q' }).url, 'https://www.helm.events/login');
  assert.equal(S.beforeSend({ url: 'https://www.helm.events/' }).url, 'https://www.helm.events/');
  assert.equal(S.beforeSend({ url: 'https://www.helm.events/privacy.html?x=1' }).url, 'https://www.helm.events/privacy.html');
  for (const bad of ['https://www.helm.events/work.html?token=abc', 'https://www.helm.events/sita-events/work/abc', 'https://www.helm.events/i/rao-wedding',
    'https://www.helm.events/approve?token=1', 'https://www.helm.events/dashboard', 'https://evil.example/pricing', 'not a url', ''])
    assert.equal(S.beforeSend({ url: bad }), null, bad);
  assert.equal(S.beforeSend(null), null);
  assert.equal(S.beforeSend({ url: 'https://www.helm.events/about', type: 'pageview' }).type, 'pageview', 'other fields kept');
});
await t('A3 loads /_vercel/insights/script.js (same origin, deferred) on the live site only, after the beforeSend stub', () => {
  const live = loadSA('https://www.helm.events/pricing');
  assert.equal(live.added.length, 1); assert.equal(live.added[0].src, '/_vercel/insights/script.js'); assert.equal(live.added[0].defer, true);
  assert.equal(typeof live.win.va, 'function'); assert.equal(live.win.vaq[0][0], 'beforeSend');
  for (const h of ['http://localhost:3000/pricing', 'http://127.0.0.1:8080/', 'http://helm.test/', 'http://app.localhost/']) assert.equal(loadSA(h).added.length, 0, h);
  assert.equal(loadSA('https://www.helm.events/dashboard').added.length, 0, 'tag copied onto an app page by mistake: nothing loads');
  const src = read('public/site-analytics.js');
  assert.ok(!/document\.cookie|localStorage|sessionStorage/.test(src), 'no cookie / storage');
  assert.ok(!/https?:\/\//.test(src.replace(/\/\*[\s\S]*?\*\//g, '')), 'no external host in code');
});
await t('A4 CSP: script-src + connect-src already allow same-origin (self) on every route; no Vercel CDN host added', () => {
  const V = JSON.parse(read('vercel.json'));
  for (const r of V.headers) for (const h of r.headers) {
    if (h.key.toLowerCase() !== 'content-security-policy') continue;
    const d = Object.fromEntries(h.value.split(';').map((x) => x.trim().split(/\s+/)).filter((x) => x[0]).map((x) => [x[0], x.slice(1)]));
    assert.ok(d['script-src'].includes("'self'"), r.source); assert.ok(d['connect-src'].includes("'self'"), r.source);
    assert.ok(!/vercel-insights|va\.vercel-scripts/.test(h.value), r.source);
  }
});

// ---------------- B1. offline queue ----------------
function store(throwing) {
  const m = new Map();
  return { m, getItem: (k) => { if (throwing) throw new Error('blocked'); return m.has(k) ? m.get(k) : null; },
    setItem: (k, v) => { if (throwing) throw new Error('blocked'); m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
}
function loadQ(o = {}) {
  const ls = o.ls || store(o.throwing), ev = {};
  const nav = { onLine: o.onLine !== false };
  const win = { localStorage: ls, navigator: nav, crypto: webcrypto, addEventListener: (ty, fn) => { (ev[ty] = ev[ty] || []).push(fn); },
    BPUI: { isNetworkError: (e) => nav.onLine === false || /failed to fetch/i.test(String(e && e.message)) } };
  const ctx = { window: win, globalThis: win, navigator: nav, TextEncoder, Uint8Array, Array, JSON, Date: o.Date || Date, Math, setTimeout: () => 0, clearTimeout: () => {} };
  vm.runInNewContext(read('public/crew-offline.js'), ctx);
  return { Q: win.HelmCrewQueue, ls, nav, win };
}
await t('B1a a press is saved once (same task + action), with its own request key; the raw token is never a storage key', async () => {
  const { Q, ls } = loadQ({ onLine: false });
  await Q.use('tok-0123456789abcdef');
  const a = Q.add({ kind: 'task', task: 't1', action: 'accept', title: 'Stage flowers' });
  const b = Q.add({ kind: 'task', task: 't1', action: 'accept', title: 'Stage flowers' });
  assert.equal(a.id, b.id); assert.match(a.id, /^[0-9a-f-]{36}$/);
  Q.add({ kind: 'task', task: 't1', action: 'start' });
  assert.equal(Q.items().length, 2);
  const keys = [...ls.m.keys()];
  assert.equal(keys.length, 1); assert.match(keys[0], /^bpwq:[0-9a-f]{64}$/);
  assert.ok(!keys[0].includes('tok-') && !ls.m.get(keys[0]).includes('tok-'), 'token never stored');
});
await t('B1b drain: sent in order; a network failure keeps the rest; a refusal removes that one', async () => {
  const { Q, nav } = loadQ({ onLine: true });
  await Q.use('tok-b');
  ['accept', 'start', 'complete'].forEach((a) => Q.add({ kind: 'task', task: 't9', action: a }));
  const sent = []; let cut = false;
  Q.sender('task', async (it) => { if (cut && it.action === 'start') throw new Error('Failed to fetch'); sent.push(it.action); });
  cut = true;
  let r = await Q.run();
  assert.deepEqual(sent, ['accept']); assert.equal(r.left, 2, 'start + complete wait');
  cut = false; r = await Q.run();
  assert.deepEqual(sent, ['accept', 'start', 'complete']); assert.equal(r.left, 0); assert.equal(r.sent, 2);
  Q.add({ kind: 'task', task: 't10', action: 'accept' });
  Q.sender('task', async () => { const e = new Error('This task has already been accepted.'); e.refused = true; throw e; });
  r = await Q.run();
  assert.equal(r.refused.length, 1); assert.equal(r.left, 0, 'a refused press is not retried forever');
  nav.onLine = false; Q.add({ kind: 'task', task: 't11', action: 'accept' });
  assert.equal(await Q.run(), null, 'offline: nothing is tried');
  assert.equal(Q.items().length, 1);
});
await t('B1c a check-in saved on an earlier day is never sent (it would count for the wrong day); the person is told', async () => {
  const ls = store();
  const a = loadQ({ ls, onLine: false }); await a.Q.use('tok-c');
  a.Q.add({ kind: 'check', action: 'in', loc: { lat: 17.4, lng: 78.5, accuracy: 20 } });
  const k = [...ls.m.keys()][0], list = JSON.parse(ls.m.get(k));
  assert.equal(list[0].loc.lat, 17.4);
  list[0].at = Date.now() - 26 * 3600 * 1000; ls.m.set(k, JSON.stringify(list));
  const b = loadQ({ ls, onLine: true }); await b.Q.use('tok-c');
  assert.equal(b.Q.items().length, 0); assert.equal(b.Q.state().expired.length, 1);
});
await t('B1d storage blocked: kept in memory for this tab, and the state says so', async () => {
  const { Q } = loadQ({ throwing: true, onLine: false });
  await Q.use('tok-d'); Q.add({ kind: 'task', task: 'x', action: 'accept' });
  assert.equal(Q.items().length, 1); assert.equal(Q.state().memoryOnly, true);
});
await t('B1e work.html + crew-self.js: offline presses are saved, shown "Saved offline", re-checked before sending', () => {
  const W = read('public/work.html'), C = read('public/crew-self.js');
  assert.match(W, /<script src="\/crew-offline\.js\?v=\d+"><\/script>/);
  assert.ok(W.indexOf('crew-offline.js') < W.indexOf('<script>\n  const $='), 'loaded before the page script');
  assert.match(W, /<div id="offQ" class="offq" role="status" aria-live="polite" hidden><\/div>/);
  assert.match(W, /if\(qOffline\(\)\)\{ queuePress\(id,action\); return; \}/);
  assert.match(W, /HelmCrewQueue\.shouldQueue\(e\)\)\{ queuePress\(id,action\); return; \}/);
  assert.match(W, /Saved offline — will send when connected/); assert.match(C, /Saved offline — will send when connected/);
  assert.match(W, /if\(st===to \|\| \(Q_RANK\[st\]!=null && Q_RANK\[to\]!=null && Q_RANK\[st\]>=Q_RANK\[to\]\)\) return;   \/\/ already done: never twice/);
  assert.match(W, /Photos need a connection/);
  assert.match(C, /if \(Q && !Q\.online\(\)\) \{ saveCheck\(action, loc, card\); return; \}/);
  assert.match(C, /if \(ci && it\.action === "in" && ci\.check_in\) return;/);
  assert.match(C, /The office sees the time it arrives/);
  assert.match(read('public/crew-shifts.css') + W, /\.offq\{/);
});

// ---------------- B2. browser check ----------------
function loadBC(o = {}) {
  const body = { firstChild: null, kids: [], insertBefore(x) { this.kids.unshift(x); } };
  const mk = () => ({ style: {}, setAttribute() {}, appendChild() {}, parentNode: null });
  const doc = { readyState: 'complete', body, getElementById: () => null, createElement: mk, createTextNode: (s) => ({ s }), addEventListener() {} };
  const P = o.oldPromise ? function () {} : Promise;
  const win = { Promise: P, fetch: o.noFetch ? undefined : () => {}, URLSearchParams, localStorage: store(o.blocked), sessionStorage: store(false) };
  const ctx = { window: win, document: doc, Object: o.oldObject ? { assign: Object.assign } : Object, RegExp: o.oldRegExp ? function (s, f) { if (f === 'u') throw new SyntaxError('x'); } : RegExp };
  if (!o.noGlobalThis) ctx.globalThis = win;
  vm.runInNewContext(read('public/browser-check.js'), ctx);
  return { win, body };
}
await t('B2a old browser = feature checks (not the browser name): banner shown; a modern one: nothing', () => {
  assert.equal(loadBC().body.kids.length, 0);
  for (const o of [{ oldPromise: true }, { noFetch: true }, { oldRegExp: true }, { oldObject: true }]) {
    const r = loadBC(o); assert.equal(r.body.kids.length, 1, JSON.stringify(o)); assert.equal(r.body.kids[0].id, 'helmOldBrowser');
  }
  const src = read('public/browser-check.js');
  assert.ok(!/userAgent|navigator\.vendor/.test(src), 'no UA sniffing');
  assert.ok(!/=>|\bclass\b|\blet\b|\bconst\b|`/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')), 'old-JS only (runs where it warns)');
});
await t('B2b blocked storage: its own polite note (sign-in and drafts need it)', () => {
  const r = loadBC({ blocked: true });
  assert.equal(r.body.kids.length, 1); assert.equal(r.body.kids[0].id, 'helmNoStorage');
});
await t('B2c on every page right after trusted-types.js (deferred), except the hidden capture host', () => {
  for (const f of PAGES) {
    const h = read('public/' + f);
    if (f === 'capture.html') { assert.ok(!/browser-check/.test(h), f); continue; }
    assert.match(h, /<script src="\/trusted-types\.js\?v=\d+"><\/script><script src="\/browser-check\.js\?v=\d+" defer><\/script>/, f);
  }
});

// ---------------- B3. formats ----------------
await t('B3a phone read-back: a valid number shows how it was read ("Saved as +91 98765 43210 · India")', () => {
  const g = { };
  const HP = (() => { const m = { exports: {} }; vm.runInNewContext(read('public/phone-input.js'), { module: m, window: undefined, globalThis: g }); return m.exports; })();
  const FV = (() => { const m = { exports: {} }; vm.runInNewContext(read('public/form-validate.js'), { module: m, window: { HelmPhone: HP } }); return m.exports; })();
  assert.equal(FV.rules.phoneShown('+919876543210'), 'Saved as +91 98765 43210 · India');
  assert.match(FV.rules.phoneShown('+12025550123'), /^Saved as \+1 .*United States$/);
  assert.equal(FV.rules.phoneShown(''), '');
});
await t('B3b e-mails: one date style everywhere ("20 Oct 2026"), times kept, anything odd unchanged', async () => {
  const { plainDate } = await import('../supabase/functions/_shared/plain-date.mjs');
  assert.equal(plainDate('20/10/2026'), '20 Oct 2026'); assert.equal(plainDate('05/01/2027'), '5 Jan 2027');
  assert.equal(plainDate('20/12/2026, 09:30 AM'), '20 Dec 2026, 09:30 AM'); assert.equal(plainDate('2026-10-20'), '20 Oct 2026');
  for (const x of ['', 'soon', '13/13/2026', '12 Dec 2026', null]) assert.equal(plainDate(x), x == null ? '' : x);
  const D = await import('../supabase/functions/comms-dispatch/delivery-reminder.mjs');
  const m = D.deliveryMessage({ kind: 'party', what: 'Chairs', due_text: '14/12/2026, 09:30 AM', studio: 'Studio A', event: 'Rao Wedding',
    event_date: '14/12/2026', party_name: 'Ravi', token: 'a'.repeat(64) }, 'https://www.helm.events');
  if (m.text) { assert.match(m.text, /Rao Wedding on 14 Dec 2026/); assert.ok(!/14\/12\/2026/.test(m.text + m.subject)); }
});
await t('B3c crew pages: "12 Nov 2026" days; money in the studio currency\'s own number style', () => {
  for (const f of ['public/crew-self.js', 'public/staff-home.js']) {
    const s = read(f), fn = /function fmtDay\(s\) \{[^\n]+\}/.exec(s)[0];
    const fmtDay = vm.runInNewContext('var MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];' + fn + '; fmtDay');
    assert.equal(fmtDay('2026-11-12'), '12 Nov 2026', f); assert.equal(fmtDay('2026-01-05T00:00:00'), '5 Jan 2026', f); assert.equal(fmtDay(''), '', f);
  }
  assert.match(read('public/crew-self.js'), /var loc = cur === "USD" \? "en-US" : cur === "AED" \? "en-AE" : "en-IN";/);
});

console.log(`\nR243 P11 + analytics: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
