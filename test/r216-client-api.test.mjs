// R216: the client link pages (approve, invite + /i/<slug>, portal, proposal-view, booklet) load the small
// public/client-api.js instead of the 568 KB staff store-api.js.
//  1. no client page references store-api.js (or preloads supabase-js); every staff page still does
//  2. client-api.js is generated from store-api.js and is up to date (word-for-word copies)
//  3. client-api.js exposes ONLY the client calls: the exact RPC / Edge Function list, no table reads, no staff namespaces
//  4. request shapes: every client call sends the SAME RPC name + arguments (and the same anon key) as store-api.js did,
//     and gets the same answer back - both scripts run in a vm sandbox side by side (no network, no real credentials)
//  5. the pages ask their independent questions at the same time, and a branded link's view is still only counted
//     after the studio check passed
import { readFileSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from '../scripts/gen-client-api.mjs';

const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const STORE = read('public/store-api.js'), CLIENT = read('public/client-api.js');
const tests = [];
const t = (name, fn) => tests.push([name, fn]);

const CLIENT_PAGES = ['approve', 'invite', 'portal', 'proposal-view', 'booklet'];
const html = (p) => read('public/' + p + '.html');

/* ------------------------------------------------------------------ 1. pages */
t('no client page loads store-api.js or preloads supabase-js; each loads client-api.js once', () => {
  for (const p of CLIENT_PAGES) {
    const h = html(p);
    assert.ok(!/store-api\.js/.test(h), p + '.html still references store-api.js');
    assert.ok(!/supabase-js-[\d.]+\.min\.js/.test(h), p + '.html still preloads supabase-js (client-api.js does not use it)');
    assert.equal((h.match(/<script src="\/client-api\.js\?v=\d+"( defer)?><\/script>/g) || []).length, 1, p + '.html must load /client-api.js?v=N exactly once');   // R224: deferred on the invitation
  }
});
t('every page reached by a client link (vercel.json rewrites) is in the client list', () => {
  const v = JSON.parse(read('vercel.json'));
  const dest = new Set((v.rewrites || []).filter((r) => /^\/(i\/|\(\[a-z0-9-\]\+\)\/(invite|quote|proposal|portal|booklet)\/|trial-preview-(approve|portal|booklet|proposal|invite))/.test(r.source))
    .map((r) => r.destination.replace(/^\//, '').replace(/\?.*$/, '')));
  for (const d of dest) assert.ok(CLIENT_PAGES.includes(d), 'client link page ' + d + ' is not on client-api.js');
});
t('client-api.js ?v= is one version everywhere; its store-api.js hand-over version matches the staff pages', () => {
  const vs = new Set(CLIENT_PAGES.map((p) => (html(p).match(/client-api\.js\?v=(\d+)/) || [])[1]));
  assert.equal(vs.size, 1, 'client-api.js version drift: ' + [...vs].join(', '));
  const staff = read('public/dashboard.html').match(/store-api\.js\?v=(\d+)/)[1];
  assert.equal((CLIENT.match(/var STORE_API_V = "(\d+)"/) || [])[1], staff, 'STORE_API_V in client-api.js must equal the staff pages\' store-api.js ?v=');
});
t('staff pages keep store-api.js (out of scope: unchanged)', () => {
  for (const p of ['dashboard', 'quotes', 'builder', 'calendar', 'ops', 'event', 'login']) assert.ok(/store-api\.js\?v=\d+/.test(html(p)), p + ' lost store-api.js');
});

/* ------------------------------------------------------------------ 2. generated + in sync */
t('client-api.js is exactly what scripts/gen-client-api.mjs builds from store-api.js (no hand edits, no drift)', () => {
  assert.equal(CLIENT, build(STORE, read('scripts/client-api.template.js')), 'run: node scripts/gen-client-api.mjs');
});

/* ------------------------------------------------------------------ 3. surface */
const ALLOWED_RPCS = ['approval_check_shown', 'create_payment', 'public_booklet_choose', 'public_booklet_otp_request', 'public_booklet_packages',
  'public_booklet_pay_terms', 'public_booklet_studio', 'public_event_site', 'public_get_booklet', 'public_get_booklet_image', 'public_get_portal',
  'public_get_proposal', 'public_get_quote', 'public_invite_info', 'public_invite_reveal', 'public_invite_rsvp', 'public_link_opened', 'public_link_studio',
  'public_link_viewed', 'public_payment_schedule', 'public_portal_extras', 'public_quote_paid_status', 'public_quote_ready', 'public_quote_validity',
  'public_request_new_quote', 'public_trial_approval_mode', 'public_trial_payment_sim', 'public_trial_sim_payments', 'public_trial_simulation',
  'public_trial_simulation_for_proposal', 'request_otp', 'trial_simulate_payment', 'trial_test_approve', 'trial_test_approve_code',
  'trial_test_mode_for_token', 'verify_and_consent', 'wa_request_otp', 'wa_verify_and_consent'];
const ALLOWED_FNS = ['create-payment-link', 'send-otp'];
t('client-api.js names only the allowed RPCs + Edge Functions, and reads no table', () => {
  const rpcs = [...new Set([...CLIENT.matchAll(/\brpc\("([a-z0-9_]+)"/g)].map((m) => m[1]))].sort();
  assert.deepEqual(rpcs, ALLOWED_RPCS.slice().sort());
  const fns = [...new Set([...CLIENT.matchAll(/callFn\("([a-z0-9-]+)"/g)].map((m) => m[1]))].sort();
  assert.deepEqual(fns, ALLOWED_FNS);
  assert.ok(!/fnUrl\("(?!booklet-snapshot")/.test(CLIENT), 'only the booklet-snapshot <img> URL is built besides callFn');
  // table access: only store-api.js's own copied tail line (BPStore.mergeAttributes, which cannot run here: `supa` is not in its scope)
  const from = CLIENT.split('\n').filter((l) => /\.from\(/.test(l) && !/storage\.from\("invite-media"\)|storage: \{ from:/.test(l));
  assert.equal(from.length, 1); assert.ok(/supa\.from\(table\)\.select\("attributes"\)/.test(from[0]));
  assert.ok(!/\/rest\/v1\/(?!rpc\/)/.test(CLIENT.replace(/\/\\\/rest\\\/v1\\\/\//g, '')), 'no direct table URL');
});

/* ---- sandboxes ---- */
function memStore(init) {
  const m = new Map(Object.entries(init || {}));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k),
    key: (i) => [...m.keys()][i] || null, get length() { return m.size; }, _m: m };
}
const CFG = { url: 'https://abcdefghijklmnopqrst.supabase.co', anonKey: 'anon-key' };
function baseWin(o) {
  const el = () => ({ style: {}, attrs: {}, children: [], dataset: {}, classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k] == null ? null : this.attrs[k]; }, hasAttribute: () => false,
    appendChild(c) { this.children.push(c); return c; }, addEventListener() {}, removeEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
    remove() {}, insertAdjacentElement() {}, closest: () => null, matches: () => false });
  const doc = {
    readyState: 'complete', addEventListener() {}, removeEventListener() {}, currentScript: null, createElement: el, createTextNode: () => el(),
    head: el(), body: el(), documentElement: Object.assign(el(), { classList: { add() {}, remove() {}, contains: () => false, toggle() {} } }),
    querySelector: () => null, querySelectorAll: () => [], getElementById: () => null, adoptedStyleSheets: [],
  };
  const win = {
    SUPABASE_CONFIG: Object.assign({}, CFG, o.cfg || {}),
    localStorage: memStore(o.ls), sessionStorage: memStore(),
    location: { pathname: o.path || '/approve', search: o.search || '', hash: o.hash || '', origin: 'https://www.helm.events', href: 'https://www.helm.events/approve', hostname: 'www.helm.events', replace() {}, reload() {} },
    history: { replaceState: (...a) => (o.history || []).push(a), state: null }, document: doc, navigator: { onLine: true, userAgent: 'TestUA/1.0' },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    setTimeout: (fn, ms) => { if (!ms || ms < 1000) { try { fn(); } catch (e) {} } return 0; }, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    console: { log() {}, info() {}, warn() {}, error() {} }, Date, Promise, URLSearchParams, URL, JSON, Math, Object, Array, String, Number, RegExp, Error, TypeError,
    Map, Set, WeakMap, Symbol, AbortSignal, encodeURI, encodeURIComponent, decodeURIComponent, isFinite, isNaN, parseInt, parseFloat, Intl,
    atob: (b) => Buffer.from(b, 'base64').toString('binary'), btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    HELM_IS_PROD_HOST: o.prod === true ? true : undefined,
  };
  win.window = win; win.globalThis = win; win.self = win;
  return win;
}
// the answer the fake server gives each RPC
const answer = (name, args) => {
  if (name === 'public_link_studio') return args.p_studio;          // "yes, this studio owns the link"
  if (name === 'public_booklet_studio') return args.p_studio;
  if (name === 'public_event_site') return [{ slug: args.p_slug, title: 'Site' }];
  if (name === 'public_get_booklet_image') return { mime: 'image/jpeg', data: 'QUJD' };
  return { ok: true, fn: name };
};
const fnAnswer = (name) => ({ status: 'sent', fn: name });
// store-api.js with a stub supabase-js (records every call)
function storeEnv(o = {}) {
  const log = [];
  const client = (headers) => ({
    auth: { async getSession() { return { data: { session: null } }; }, onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
      mfa: { async getAuthenticatorAssuranceLevel() { return { data: { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null }; } } },
    async rpc(name, args) { log.push(['rpc', name, JSON.parse(JSON.stringify(args === undefined ? {} : args))]);
      if (o.fail && o.fail[name]) return { data: null, error: o.fail[name] };
      return { data: answer(name, args || {}), error: null }; },
    storage: { from: (b) => ({ async createSignedUrls(paths, s) { log.push(['sign', b, paths, s, (headers || {})['x-helm-site-slug'] || null]);
      return { data: paths.map((p) => ({ path: p, signedURL: '/object/sign/' + b + '/' + p + '?token=t', signedUrl: CFG.url + '/storage/v1/object/sign/' + b + '/' + p + '?token=t', error: null })), error: null }; } }) },
    from() { throw new Error('no table reads expected'); },
  });
  const win = baseWin(o);
  win.supabase = { createClient: (u, k, opts) => client(opts && opts.global && opts.global.headers) };
  win.fetch = async (url, init) => {
    if (/\/functions\/v1\//.test(url)) { const n = url.split('/functions/v1/')[1]; log.push(['fn', n, JSON.parse(init.body), init.headers.Authorization]); return { ok: true, status: 200, json: async () => fnAnswer(n) }; }
    return { ok: false, status: 503, json: async () => ({}) };
  };
  vm.createContext(win);
  vm.runInContext(STORE, win, { filename: 'store-api.js' });
  return { win, S: win.BPStore, log };
}
// client-api.js with a stub fetch (records the real HTTP requests it makes)
function clientEnv(o = {}) {
  const log = [], reqs = [];
  const win = baseWin(o);
  const res = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => (body === undefined ? '' : JSON.stringify(body)), json: async () => body });
  win.fetch = async (url, init) => {
    reqs.push({ url, init });
    if (o.networkDown) throw new TypeError('Failed to fetch');
    const rp = /\/rest\/v1\/rpc\/([a-z0-9_]+)$/.exec(url);
    if (rp) { const args = JSON.parse(init.body); log.push(['rpc', rp[1], args]);
      if (o.fail && o.fail[rp[1]]) return res(400, o.fail[rp[1]]);
      return res(200, answer(rp[1], args)); }
    const sg = /\/storage\/v1\/object\/sign\/([a-z-]+)$/.exec(url);
    if (sg) { const b = JSON.parse(init.body); log.push(['sign', sg[1], b.paths, b.expiresIn, init.headers['x-helm-site-slug'] || null]);
      return res(200, b.paths.map((p) => ({ path: p, signedURL: '/object/sign/' + sg[1] + '/' + p + '?token=t', error: null }))); }
    if (/\/functions\/v1\//.test(url)) { const n = url.split('/functions/v1/')[1]; log.push(['fn', n, JSON.parse(init.body), init.headers.Authorization]); return { ok: true, status: 200, json: async () => fnAnswer(n) }; }
    return res(404, {});
  };
  vm.createContext(win);
  vm.runInContext(CLIENT, win, { filename: 'client-api.js' });
  return { win, S: win.BPStore, log, reqs };
}
const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => { for (let i = 0; i < 8; i++) await tick(); };

t('client-api.js exposes only the client namespaces (no staff API: quotes, auth.signIn, org, staff, chat ...)', () => {
  const { S } = clientEnv();
  const core = ['init', 'mode', 'links', 'approval', 'quoteValidity', 'proposal', 'sites', 'portal', 'paySchedule', 'pricing', 'auth', 'booklet', 'pkgflow'];
  for (const k of core) assert.ok(k in S, 'missing ' + k);
  assert.deepEqual(Object.keys(S.auth), ['user']); assert.equal(S.auth.user(), null);
  assert.deepEqual(Object.keys(S.links).sort(), ['base', 'parse', 'require', 'verify']);
  assert.deepEqual(Object.keys(S.booklet).sort(), ['get', 'payTerms', 'publicImage', 'snapshotUrl', 'studioOk']);
  assert.deepEqual(Object.keys(S.pkgflow).sort(), ['choose', 'otpRequest', 'packages']);
  assert.deepEqual(Object.keys(S.pricing).sort(), ['_canon', 'quoteTotal']);
  for (const staff of ['quotes', 'org', 'staff', 'chat', 'ops', 'leads', 'inventory', 'settlement', 'audit', 'bell', 'presence', 'subscription', 'config', 'files', 'media', 'uploads'])
    assert.ok(!(staff in S), 'staff namespace ' + staff + ' must not be in client-api.js');
  for (const staff of ['generateToken', 'markPaid', 'consents', 'payments', 'notifications', 'waSend', 'emailLink', 'trialSimRows', 'trialSimPayments'])
    assert.ok(!(staff in S.approval), 'staff call approval.' + staff + ' must not be in client-api.js');
  // everything else on BPStore comes from store-api.js's own page-helper tail (tax / dates / phone), copied as it is
  const tail = new Set([...STORE.matchAll(/^\s*BPStore\.([A-Za-z_]+) = /gm)].map((m) => m[1]));
  for (const k of Object.keys(S)) assert.ok(core.includes(k) || tail.has(k), 'unexpected BPStore.' + k);
  for (const g of ['HelmUrl', 'BPUI', 'HelmSettingsName']) assert.ok(g in clientEnv().win, g);
});

/* ------------------------------------------------------------------ 4. request shapes: before (store-api) vs after (client-api) */
const T = '11111111-2222-4333-8444-555555555555', HEX = 'a'.repeat(64), MEDIA = CFG.url + '/storage/v1/object/public/invite-media/org/q/p1.jpg';
const CALLS = [
  ['approval.getByToken', [T]], ['approval.paidStatus', [T]], ['approval.requestOtp', [T, '+919876543210']],
  ['approval.verifyConsent', [T, '+919876543210', '123456', true, 'v3-2026-10', 'consent text', 'Asha', 'UA']],
  ['approval.checkShown', [T, 200600]], ['approval.createPayment', [T]],
  ['approval.requestChannelOtp', [T, 'whatsapp']], ['approval.requestChannelOtp', [T, 'email']],
  ['approval.verifyChannel', [T, 'email', '123456', true, 'v3-2026-10', 'consent text', 'Asha', 'UA']],
  ['approval.quoteReady', [T]], ['approval.trialTestMode', [T]], ['approval.trialMode', [T]],
  ['approval.trialSimPage', ['quote', T]], ['approval.trialSimPage', ['booklet', T]], ['approval.trialSimPage', ['site', 'demo-slug']], ['approval.trialSimPage', ['proposal', T]],
  ['approval.trialPaymentSim', [T]], ['approval.trialSimulatePayment', [T, 'Asha', 'UA']], ['approval.trialSimList', ['quote', T]], ['approval.trialSimList', ['booklet', T]],
  ['approval.trialTestApproveCode', [T, '000000', '+919876543210', 'Asha', 'v3-2026-10', 'consent text', 'UA']],
  ['quoteValidity.publicState', ['quote', T]], ['quoteValidity.publicState', ['booklet', T]], ['quoteValidity.requestNew', ['quote', T, 'please']],
  ['proposal.getByToken', [T]],
  ['links.verify', [{ studio: 'demo-studio', kind: 'quote', ref: T }]], ['links.require', [{ studio: 'demo-studio', kind: 'portal', ref: T }]], ['links.require', [null]],
  ['sites.public', ['demo-slug']], ['sites.publicInfo', ['demo-slug']],
  ['sites.rsvp', ['demo-slug', { name: 'Asha', attending: 'yes', guests: 2, message: 'See you', token: HEX, website: '' }]],
  ['sites.reveal', ['demo-slug', HEX]], ['sites.reveal', ['demo-slug', 'not-a-token']], ['sites.mediaUrls', [[MEDIA, 'https://example.com/x.jpg'], undefined, 'demo-slug']],
  ['portal.get', [T]], ['portal.extras', [T]], ['paySchedule.publicGet', [T]],
  ['booklet.get', [T]], ['booklet.payTerms', [T]], ['booklet.studioOk', [T, 'demo-studio']], ['booklet.publicImage', [T, '2d', 'labels']], ['booklet.publicImage', [T, 'photo', 'plain']],
  ['booklet.snapshotUrl', [T, '3d']],
  ['pkgflow.packages', [T]], ['pkgflow.choose', [T, 'gold', 120, 'note', ' 123456 ']], ['pkgflow.otpRequest', [T]],
];
const get = (S, path) => { const ks = path.split('.'); const fnName = ks.pop(); const obj = ks.reduce((o, k) => o[k], S); return [obj, obj[fnName]]; };
async function runAll(env, calls) {
  await env.S.init();
  const out = [];
  for (const [path, args] of calls) {
    env.log.length = 0;
    const [obj, fn] = get(env.S, path);
    let r, e = null;
    try { r = await fn.apply(obj, JSON.parse(JSON.stringify(args === undefined ? [] : args), (k, v) => v)); } catch (x) { e = { message: String(x && x.message), code: (x && x.code) || null }; }
    await settle();
    // fire-and-forget calls (the link view count) may land in a different order: compare the set of requests
    out.push({ path, result: e ? null : JSON.parse(JSON.stringify(r === undefined ? null : r)), error: e, calls: env.log.map((c) => JSON.stringify(c)).sort() });
  }
  return out;
}
const fixArgs = (calls) => calls.map(([p, a]) => [p, a.map((x) => (x === undefined ? null : x))]);
async function compare(o, calls) {
  const a = await runAll(storeEnv(o), fixArgs(calls)), b = await runAll(clientEnv(o), fixArgs(calls));
  for (let i = 0; i < a.length; i++) assert.deepEqual(b[i], a[i], 'different from store-api.js: ' + a[i].path + ' ' + JSON.stringify(calls[i][1]));
  return { a, b };
}
t('request shapes: every client call sends the same RPC name + arguments and returns the same answer as store-api.js', async () => {
  const { a } = await compare({}, CALLS);
  const names = new Set(a.flatMap((x) => x.calls.map((c) => JSON.parse(c)).filter((c) => c[0] === 'rpc').map((c) => c[1])));
  for (const n of names) assert.ok(ALLOWED_RPCS.includes(n), n);
  assert.ok(names.size >= 30, 'the comparison covers the client RPCs (' + names.size + ')');
});
t('request shapes: the live channels (send-otp / create-payment-link Edge Functions) are called the same way', async () => {
  const live = { cfg: { liveChannels: { sms: true, pay: true, whatsapp: true, email: true } } };
  const { a } = await compare(live, CALLS.filter(([p]) => /requestOtp|requestChannelOtp|createPayment/.test(p)));
  assert.ok(a.every((x) => x.calls.map((c) => JSON.parse(c)).some((c) => c[0] === 'fn' && c[3] === 'Bearer anon-key')), 'signed-out client: anon key as bearer');
});
t('request shapes: production host refuses the simulated payment exactly as before', async () => {
  await compare({ prod: true }, [['approval.createPayment', [T]]]);
});
t('request shapes: a server refusal reaches the page with the same message + code', async () => {
  const fail = { public_get_quote: { code: 'P0001', message: 'invalid link', details: null, hint: null },
    public_get_portal: { code: 'P0001', message: 'This event has been cancelled', details: null, hint: null },
    public_invite_info: { code: 'PGRST202', message: 'Could not find the function public.public_invite_info', details: null, hint: null },
    public_booklet_packages: { code: '42883', message: 'function public_booklet_packages does not exist', details: null, hint: null },
    public_trial_approval_mode: { code: 'P0001', message: 'x', details: null, hint: null } };
  const { a } = await compare({ fail }, [['approval.getByToken', [T]], ['portal.get', [T]], ['sites.publicInfo', ['demo-slug']], ['pkgflow.packages', [T]], ['approval.trialMode', [T]]]);
  assert.equal(a[0].error.message, 'invalid link'); assert.equal(a[0].error.code, 'P0001');
  assert.equal(a[2].result, null, 'a missing function answers null (as before)');
});
t('request shapes: the same URL, anon key and headers supabase-js sent for a signed-out visitor', async () => {
  const env = clientEnv(); await env.S.init(); await env.S.approval.getByToken(T); await settle();
  const r = env.reqs.find((x) => /public_get_quote$/.test(x.url));
  assert.equal(r.url, CFG.url + '/rest/v1/rpc/public_get_quote');
  assert.equal(r.init.method, 'POST'); assert.equal(r.init.cache, 'no-store');
  assert.equal(r.init.headers.apikey, 'anon-key'); assert.equal(r.init.headers.Authorization, 'Bearer anon-key');
  assert.equal(r.init.headers['Content-Type'], 'application/json'); assert.equal(r.init.headers['Content-Profile'], 'public');
  assert.equal(r.init.body, JSON.stringify({ p_token: T }));
  assert.ok(r.init.signal, '30 s timeout signal (as store-api.js)');
  // the guest photo signing carries the invitation slug (0048) and the anon key
  await env.S.sites.mediaUrls([MEDIA], undefined, 'demo-slug');
  const s = env.reqs.find((x) => /\/storage\/v1\/object\/sign\/invite-media$/.test(x.url));
  assert.equal(s.init.headers['x-helm-site-slug'], 'demo-slug'); assert.equal(s.init.headers.Authorization, 'Bearer anon-key');
});
t('a network failure reads as a network error (BPUI "Couldn\'t reach the server" + Retry), not as "link not found"', async () => {
  const env = clientEnv({ networkDown: true }); await env.S.init();
  let e = null; try { await env.S.approval.getByToken(T); } catch (x) { e = x; }
  assert.ok(e && /^TypeError: Failed to fetch/.test(e.message));
  assert.equal(env.win.BPUI.isNetworkError(e), true); assert.equal(env.win.BPUI.isNotFound(e), false);
});
t('no Supabase config (local fail-closed): the same "Supabase not configured" as store-api.js', async () => {
  const o = { cfg: { url: '', anonKey: '' } };
  const s = storeEnv(o), c = clientEnv(o);
  assert.equal(await c.S.init(), await s.S.init());
  const err = async (S) => { try { await S.approval.getByToken(T); return null; } catch (e) { return e.message; } };
  assert.equal(await err(c.S), await err(s.S));
});

/* ------------------------------------------------------------------ full mode (a signed-in browser) */
t('a browser with a stored sign-in (or the trial flag) loads the full store-api.js and every call goes through it', async () => {
  for (const ls of [{ 'sb-abcdefghijklmnopqrst-auth-token': '{"access_token":"x"}' }, { 'helm.trial': '1' }]) {
    const appended = [];
    const win = baseWin({ ls });
    let loadCb = null;
    win.document.getElementById = (id) => (id === 'helmStoreApi' ? { addEventListener: (ev, f) => { if (ev === 'load') loadCb = f; } } : null);
    win.document.head.appendChild = (s) => { appended.push(s); return s; };
    win.fetch = async () => { throw new Error('client-api.js itself must not fetch in full mode'); };
    vm.createContext(win); vm.runInContext(CLIENT, win);
    assert.equal(win.__HELM_CLIENT_FULL__, true);
    const s = appended.find((x) => x && x.id === 'helmStoreApi');
    assert.ok(s && s.src === '/store-api.js?v=' + CLIENT.match(/var STORE_API_V = "(\d+)"/)[1], 'store-api.js is loaded');
    const light = win.BPStore;
    assert.equal(light.links.parse('quote'), null, 'sync helpers work before store-api.js arrives');
    const seen = [];
    const fullStore = { init: async () => 'supabase', mode: () => 'supabase', auth: { user: () => ({ id: 'u1' }) },
      approval: { getByToken: async (tok) => { seen.push(['getByToken', tok]); return { full: true }; } } };
    const p = light.approval.getByToken(T);
    win.BPStore = fullStore; loadCb();          // store-api.js ran (it sets window.BPStore) and fired load
    assert.deepEqual(await p, { full: true }); assert.deepEqual(seen, [['getByToken', T]]);
    assert.equal(await light.init(), 'supabase'); assert.equal(light.auth.user().id, 'u1');
  }
  const plain = clientEnv(); assert.equal(plain.win.__HELM_CLIENT_FULL__, false, 'a client browser stays on the small script');
});

/* ------------------------------------------------------------------ 5. parallel + view gate */
t('a branded link\'s view is counted only after the studio check passed (now asked in parallel)', async () => {
  const L = { studio: 'demo-studio', kind: 'quote', ref: T };
  const env = clientEnv(); await env.S.init();
  await Promise.allSettled([env.S.links.require(L), env.S.approval.getByToken(T)]); await settle();
  const order = env.log.map((c) => c[1]);
  assert.ok(order.indexOf('public_link_viewed') > order.indexOf('public_link_studio'), order.join(','));
  // wrong studio: no view is counted at all
  const env2 = clientEnv({ fail: {} }); await env2.S.init();
  const bad = { studio: 'other-studio', kind: 'quote', ref: T };
  env2.win.fetch = ((f) => async (url, init) => (/public_link_studio$/.test(url) ? { ok: true, status: 200, text: async () => JSON.stringify(null) } : f(url, init)))(env2.win.fetch);
  const [rq] = await Promise.allSettled([env2.S.links.require(bad), env2.S.approval.getByToken(T)]); await settle();
  assert.equal(rq.status, 'rejected'); assert.equal(rq.reason.code, 'PGRST116');
  assert.ok(!env2.log.some((c) => c[1] === 'public_link_viewed' || c[1] === 'public_link_opened'), 'no view for a mismatched studio');
});
t('the pages ask independent questions together (studio check + data; follow-up reads)', () => {
  const a = html('approve'), p = html('portal'), v = html('proposal-view'), i = html('invite'), b = read('public/booklet.js');
  assert.ok(/Promise\.allSettled\(\[BPStore\.links\.require\(LINK\), BPStore\.approval\.getByToken\(token\)\]\)/.test(a), 'approve: link check + quote together');
  assert.ok(/Promise\.allSettled\(\[BPStore\.links\.require\(LINK\), BPStore\.portal\.get\(token\)\]\)/.test(p), 'portal: link check + portal together');
  assert.ok(/Promise\.allSettled\(\[BPStore\.links\.require\(LINK\), BPStore\.proposal\.getByToken\(token\)\]\)/.test(v), 'proposal: link check + proposal together');
  assert.ok(/Promise\.allSettled\(\[BPStore\.links\.require\(LINK\), BPStore\.sites\.public\(slug\)\]\)/.test(i), 'invite: link check + site together');
  assert.ok(/Promise\.all\(\[infoP, revealP, photosP\]\)/.test(i), 'invite: studio name, reply reveal and photos together');
  assert.ok(/Promise\.allSettled\(\[pretty \? global\.BPStore\.booklet\.studioOk\(token, pretty\.studio\) : true, global\.BPStore\.booklet\.get\(token\)\]\)/.test(b), 'booklet: studio check + booklet together');
  assert.ok(/PRE_PAID = BPStore\.approval\.paidStatus\(token\)/.test(p) && /PRE_SCHED = BPStore\.paySchedule\.publicGet\(token\)/.test(p), 'portal: payment reads start together');
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log('  ok ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + '\n    ' + (e && e.stack || e).toString().split('\n').slice(0, 60).join('\n    ')); }
}
console.log(`r216-client-api: ${tests.length - failed} passed, ${failed} failed`);
if (failed) process.exit(1);
