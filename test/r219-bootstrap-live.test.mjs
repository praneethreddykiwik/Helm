// r219-bootstrap-live.test.mjs - R219 (live dashboard 18 Nov 2026, prod 3d15d455): page_bootstrap (R217 / 0389) shipped, yet a
// reloaded dashboard made 68 Supabase requests, page_bootstrap 0 times, and still asked my_trial_org / my_trial_status /
// my_test_studio / my_profile / quotes / chat twice or three times. Three causes, each covered here:
//   1. the shell scripts ask BPStore while page_bootstrap is still on its way -> each found an empty cache and sent its own
//      request. The helpers now wait for the startup answers (never longer than the 4 s deadline + 1 s).
//   2. a reload inside a minute skipped page_bootstrap (sign-in answers fresh) although the trial / demo / pricing /
//      rate-card answers were missing or old -> each was asked on its own. bootNeeded() now counts those too.
//   3. ten read-only (STABLE) functions the pages ask while they boot were not in READ_RPCS, so each counted as a WRITE
//      and dropped every shared read, the per-page memo and the per-tab caches -> the widgets read everything again.
//      Two small real writes (presence heartbeat, link-views sweep) now drop only what they can change.
// Request counts in a real browser (mocked Supabase, nothing leaves the machine): scripts/r219-request-count.mjs.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';

const ROOT = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');
const SRC = read('public/store-api.js');
const tests = [];
const t = (name, fn) => tests.push([name, fn]);

const LAT = 20;          // ms per simulated database trip (250 ms from India; scaled so the suite stays fast)
const ORG = 'org-1';
function memStore(init) {
  const m = new Map(Object.entries(init || {}));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k),
    key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; }, _m: m };
}
const entry = (uid, val, ageMs) => JSON.stringify({ ts: Date.now() - ageMs, uid, val });
// the database as the old separate calls see it
function world(o = {}) {
  const role = o.role || 'sales';
  const rows = o.rows || [{ area: 'leads', can_view: true, can_edit: false }, { area: 'quotes', can_view: true, can_edit: true }];
  const w = {
    current_org_id: o.org === undefined ? ORG : o.org,
    my_profile_status: o.profile || { complete: true, required: false, nudge: false },
    my_checkout_status: o.checkout || { required: false, is_admin: role === 'admin', has_subscription: true, reason: 'subscribed', pending_payment: false },
    password_change_required: o.pw === true,
    my_trial_org: o.trialOrg || { is_trial_org: false, read_only: !!o.readOnly, is_admin: role === 'admin' },
    my_trial_status: o.trial || { status: null, state: 'none', is_admin: role === 'admin' },
    my_demo_status: { has_demo: false, demo_rows: 0, is_admin: role === 'admin' },
    my_subscription: { status: 'active', read_only: false },
    my_test_studio: o.testStudio === true,
    get_pricing_config: { chairPrice: 250, gstPct: 18, currency: 'INR', country: 'IN' },
    get_item_rate_cards: { rates: { chair: { rent: 40 } }, canEdit: role === 'admin', custom: ['chair'] },
    profile_role: role,
    role_access: rows,
  };
  return w;
}
function bootAnswer(w, o = {}) {
  const parts = {}; const errors = {};
  for (const k of ['current_org_id', 'my_profile_status', 'my_checkout_status', 'password_change_required', 'profile_role', 'my_trial_org', 'my_trial_status', 'my_demo_status', 'my_subscription', 'my_test_studio', 'get_pricing_config', 'get_item_rate_cards']) parts[k] = w[k];
  if (w.current_org_id) parts.role_access = w.role_access;
  for (const k of (o.failParts || [])) { delete parts[k]; errors[k] = '42501'; }
  return { v: 1, parts, errors };
}
function makeEnv(o = {}) {
  const w = world(o);
  const calls = [];
  let inflight = 0, peak = 0, t0 = Date.now();
  const user = { id: o.uid || 'u-1', email: 'staff@a.test' };
  const session = { user, access_token: 'x' };
  const cls = new Set(['auth-pending']);
  const trip = (name, answer) => {
    calls.push({ name, at: Date.now() - t0 });
    inflight++; peak = Math.max(peak, inflight);
    return new Promise((res) => setTimeout(() => { inflight--; res(typeof answer === 'function' ? answer() : answer); }, LAT));
  };
  const boot = o.boot || 'ok';
  const client = {
    auth: {
      async getSession() { return { data: { session } }; },
      onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
      async refreshSession() { return { data: { session }, error: null }; },
      async signOut() { return { error: null }; },
      mfa: { async getAuthenticatorAssuranceLevel() { return { data: { currentLevel: 'aal1', nextLevel: o.mfaPending ? 'aal2' : 'aal1' }, error: null }; },
        async listFactors() { return { data: { all: [], totp: [] }, error: null }; } },
    },
    channel() { return { on() { return this; }, subscribe() { return this; }, track() {}, untrack() {}, unsubscribe() {} }; },
    removeChannel() {},
    rpc(name) {
      if (name === 'page_bootstrap') {
        if (boot === 'missing') return trip(name, { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.page_bootstrap', status: 404 } });
        if (boot === 'error') return trip(name, { data: null, error: { code: 'XX000', message: 'boom', status: 500 } });
        if (boot === 'hang') { calls.push({ name, at: Date.now() - t0 }); return new Promise(() => {}); }
        if (boot === 'garbled') return trip(name, { data: { parts: [] }, error: null });
        return trip(name, { data: bootAnswer(w, o), error: null });
      }
      if (name === 'my_trial_org' && (o.failParts || []).includes('my_trial_org')) return trip(name, { data: null, error: { code: '42501', message: 'not authorized' } });
      if (Object.prototype.hasOwnProperty.call(w, name)) return trip(name, { data: w[name], error: null });
      return trip(name, { data: null, error: null });
    },
    from(table) {
      const q = { select: () => q, eq: () => q, order: () => q, in: () => q, limit: () => q,
        maybeSingle: () => trip('from:' + table, { data: table === 'profiles' ? { role: w.profile_role } : null, error: null }),
        single: () => trip('from:' + table, { data: table === 'profiles' ? { role: w.profile_role } : null, error: null }),
        then: (res, rej) => trip('from:' + table, { data: table === 'role_access' ? w.role_access : [], error: null }).then(res, rej) };
      return q;
    },
  };
  const loc = { pathname: o.path || '/dashboard', search: '', hash: '', origin: 'https://www.helm.events', href: '', hostname: 'www.helm.events',
    replace(u) { calls.push({ name: 'location.replace:' + u }); }, reload() { calls.push({ name: 'location.reload' }); } };
  const el = (tag) => ({ tag, style: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, appendChild() {}, addEventListener() {}, querySelector: () => null, remove() {} });
  const doc = {
    readyState: 'complete', addEventListener() {}, removeEventListener() {}, currentScript: { src: 'https://www.helm.events/store-api.js?v=397' },
    createElement: el, head: { appendChild() {} }, body: { children: [], appendChild(c) { this.children.push(c); }, removeChild() {}, get firstChild() { return null; } },
    documentElement: { setAttribute() {}, getAttribute() { return 'light'; },
      classList: { contains: (c) => cls.has(c), add: (c) => { cls.add(c); }, remove: (c) => { cls.delete(c); } } },
    querySelector: () => null, querySelectorAll: () => [], getElementById: () => null, visibilityState: 'visible', hidden: false,
  };
  const ls = o.ls || memStore(), ss = o.ss || memStore();
  const captured = {}, fetches = [];
  const win = {
    SUPABASE_CONFIG: { url: 'https://abcdefghijklmnopqrst.supabase.co', anonKey: 'anon' },
    supabase: { createClient: (u, k, opts) => { captured.fetch = opts && opts.global && opts.global.fetch; return client; } },
    localStorage: ls, sessionStorage: ss, location: loc, document: doc, navigator: { onLine: true },
    fetch: (url, init) => { fetches.push({ url: String(url), method: (init && init.method) || 'GET' }); return new Promise((res) => setTimeout(() => res(new Response('{}', { status: 200 })), LAT)); },
    addEventListener() {}, removeEventListener() {},
    // real timers, scaled: the 4 s page_bootstrap deadline = 200 ms here; the 1.5 s presence start never fires in a test
    setTimeout: (fn, ms) => (ms >= 1500 && ms !== 4000 ? 0 : setTimeout(fn, ms === 4000 ? 200 : ms)), clearTimeout: (h) => clearTimeout(h),
    setInterval: () => 0, clearInterval() {},
    atob: (b) => Buffer.from(b, 'base64').toString('binary'),
    console: { log() {}, info() {}, warn() {}, error() {} },
    Response: globalThis.Response, structuredClone: globalThis.structuredClone, URLSearchParams, Date, JSON, Promise, Map, Set,
  };
  win.window = win; win.globalThis = win;
  vm.createContext(win);
  vm.runInContext(SRC, win, { filename: 'store-api.js' });
  const S = win.BPStore;
  return { win, S, calls, ss, ls, captured, fetches, gated: () => cls.has('auth-pending'), peak: () => peak,
    names: () => calls.map((c) => c.name), net: () => calls.filter((c) => !c.name.startsWith('location.')),
    replaced: () => calls.filter((c) => c.name.startsWith('location.replace:')).map((c) => c.name.slice(17)),
    reset() { calls.length = 0; peak = 0; t0 = Date.now(); } };
}
// what the shell + page ask right after the page shows (auth-ui chrome + the page's access checks)

const SRC_MIGS = readdirSync(new URL('supabase/migrations/', ROOT)).filter((f) => /^\d{4}.*\.sql$/.test(f)).sort();
const OLD_SEP = ['current_org_id', 'from:profiles', 'from:role_access', 'my_trial_org', 'my_trial_status', 'my_demo_status', 'my_subscription', 'my_test_studio', 'get_pricing_config', 'get_item_rate_cards'];
// what the shell (rail, search, trial strip, banners) asks while init() is still waiting for page_bootstrap
const shellAsks = (S) => Promise.all([() => S.auth.role(), () => S.auth.canView('leads'), () => S.trialOrg.status(), () => S.subscription.trial(), () => S.subscription.mine(),
  () => S.auth.mfa.testStudio(), () => S.demo.status(), () => S.config.getPricing(), () => S.config.itemRates(), () => S.auth.canEditArea('quotes')].map((f) => Promise.resolve().then(f).catch((e) => 'ERR ' + ((e && e.code) || ''))));

/* ---------------------------------------------------------- 1. helpers asked during page_bootstrap wait for it */
for (const role of ['admin', 'sales', 'planner']) {
  t(`${role}: the shell asks role / trial / plan / test studio / pricing while page_bootstrap is on its way -> only page_bootstrap goes out, same answers`, async () => {
    const run1 = async (boot) => {
      const e = makeEnv({ role, boot });
      const init = e.S.init();
      await new Promise((r) => setTimeout(r, 5));            // the page_bootstrap request is in flight
      const early = shellAsks(e.S);
      await init; const a = await early; const b = await shellAsks(e.S);
      return { e, a, b, names: e.net().map((c) => c.name).filter((n) => n !== 'from:organizations') };
    };
    const neu = await run1('ok'), old = await run1('missing');
    assert.deepEqual(neu.names, ['page_bootstrap'], neu.names.join(', '));
    assert.deepEqual(JSON.parse(JSON.stringify(neu.a)), JSON.parse(JSON.stringify(old.a)), 'answers equal the separate calls');
    assert.deepEqual(JSON.parse(JSON.stringify(neu.b)), JSON.parse(JSON.stringify(old.b)));
    for (const n of OLD_SEP) assert.ok(old.names.includes(n), 'fallback still asks ' + n);
  });
}
t('page_bootstrap never answers: the waiting helpers go on after the deadline with the old calls (no page hangs)', async () => {
  const e = makeEnv({ role: 'sales', boot: 'hang' });
  const init = e.S.init(); await new Promise((r) => setTimeout(r, 5));
  const t0 = Date.now(); const early = shellAsks(e.S); await init; const a = await early;
  assert.ok(Date.now() - t0 < 2000, 'scaled deadline: ' + (Date.now() - t0));
  assert.equal(a[0], 'sales');
  for (const n of ['my_trial_org', 'my_test_studio', 'get_pricing_config']) assert.ok(e.names().includes(n), n);
});
t('a sign-in step pending (two-step code): helpers waiting on the startup answers are released (the page goes to sign-in)', async () => {
  const e = makeEnv({ mfaPending: true, org: null });
  const init = e.S.init(); await new Promise((r) => setTimeout(r, 5));
  let done = false; Promise.resolve().then(() => e.S.trialOrg.status()).catch(() => null).then(() => { done = true; });
  await Promise.race([init, new Promise((r) => setTimeout(r, 400))]);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(done, true, 'released'); assert.equal(e.gated(), true); assert.deepEqual(e.replaced(), ['/login?next=dashboard']);
});

/* ---------------------------------------------------------- 2. a reload inside a minute */
t('reload inside a minute with the trial / pricing answers gone or old: ONE page_bootstrap instead of the separate calls', async () => {
  const a = await (async () => { const e = makeEnv({ role: 'admin' }); await e.S.init(); await shellAsks(e.S); return e; })();
  const ss = a.ss;
  // what the previous page left: sign-in answers fresh, the per-tab trial / demo / pricing / rate-card answers 30 s old
  for (const n of ['trialorg', 'trial', 'demo', 'pricing', 'rates']) { const o = JSON.parse(ss.getItem('bp_swr:' + n)); o.ts -= 30000; ss.setItem('bp_swr:' + n, JSON.stringify(o)); }
  const e = makeEnv({ role: 'admin', ss });
  await e.S.init(); await shellAsks(e.S);
  const names = e.net().map((c) => c.name).filter((n) => n !== 'from:organizations');
  assert.deepEqual(names, ['page_bootstrap'], names.join(', '));
});
t('reload a few seconds later (everything fresh): nothing but the uncached plan + test-studio answers, as before', async () => {
  const e1 = makeEnv({ role: 'admin' }); await e1.S.init(); await shellAsks(e1.S);
  const e = makeEnv({ role: 'admin', ss: e1.ss }); await e.S.init(); await shellAsks(e.S);
  const names = e.net().map((c) => c.name).filter((n) => n !== 'from:organizations').sort();
  assert.deepEqual(names, ['my_subscription', 'my_test_studio']);
});

/* ---------------------------------------------------------- 3. reads that counted as writes */
const NEW_READS = ['audit_actor_names', 'crew_unavailable_conflicts', 'dashboard_money_for', 'event_group_index', 'event_reminder_settings_get',
  'link_views_summary', 'live_events_today', 'presence_list', 'quote_validity_list', 'recent_list'];
const lastDef = (fn) => { let body = null;
  for (const f of SRC_MIGS) { const sql = read('supabase/migrations/' + f); const re = new RegExp('create or replace function public\\.' + fn + '\\([^)]*\\)\\s*returns[\\s\\S]{0,200}?language \\w+ (stable|volatile|immutable)', 'gi'); let m; while ((m = re.exec(sql))) body = m[1].toLowerCase(); }
  return body; };
t('the ten names added to READ_RPCS are read-only (STABLE) in their latest migration; the two narrow writes are real writes', () => {
  for (const fn of NEW_READS) { assert.ok(new RegExp('\\|' + fn + '[|)]').test(SRC.match(/const READ_RPCS = .*/)[0]), fn + ' listed'); assert.equal(lastDef(fn), 'stable', fn); }
  for (const fn of ['presence_touch', 'link_views_attention']) assert.equal(lastDef(fn), 'volatile', fn);
  assert.match(SRC, /presence_touch: \{ reads: /); assert.match(SRC, /link_views_attention: \{ reads: [^\n]*bell_feed[^\n]*memo: \["bell\.feed:", "ops\.pending"\] \}/);
});
async function fetchEnv() { const e = makeEnv({ role: 'admin' }); await e.S.init(); e.fetches.length = 0; return e; }
const U = 'https://abcdefghijklmnopqrst.supabase.co/rest/v1/';
const post = (fn, body = '{}') => ({ method: 'POST', body, headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json' } });
t('two widgets asking the same read-only function at once share ONE request; each gets its own copy', async () => {
  const e = await fetchEnv(); const f = e.captured.fetch;
  const [a, b] = await Promise.all([f(U + 'rpc/event_reminder_settings_get', post()), f(U + 'rpc/event_reminder_settings_get', post())]);
  assert.equal(e.fetches.length, 1); assert.notEqual(a, b); assert.equal(await a.text(), await b.text());
  await Promise.all([f(U + 'rpc/recent_list', post('', '{"p_limit":10}')), f(U + 'rpc/recent_list', post('', '{"p_limit":20}'))]);
  assert.equal(e.fetches.length, 3, 'different arguments = different requests');
});
t('a read-only function no longer drops the shared reads; a real write still does', async () => {
  const e = await fetchEnv(); const f = e.captured.fetch;
  await f(U + 'quotes?select=id', { headers: { Authorization: 'Bearer x' } });
  await f(U + 'rpc/dashboard_money_for', post('', '{"p_months":12}'));
  await f(U + 'quotes?select=id', { headers: { Authorization: 'Bearer x' } });
  assert.equal(e.fetches.filter((x) => x.url.includes('quotes?')).length, 1, 'shared');
  await f(U + 'rpc/save_quote', post('', '{}'));
  await f(U + 'quotes?select=id', { headers: { Authorization: 'Bearer x' } });
  assert.equal(e.fetches.filter((x) => x.url.includes('quotes?')).length, 2, 'a write drops the shared read');
});
t('narrow writes: always sent (never shared); drop only the reads they change; keep the per-tab caches', async () => {
  const e = await fetchEnv(); const f = e.captured.fetch;
  const H = { headers: { Authorization: 'Bearer x' } };
  const n = (part) => e.fetches.filter((x) => x.url.includes(part)).length;
  await Promise.all([f(U + 'rpc/presence_touch', post()), f(U + 'rpc/presence_touch', post())]);
  assert.equal(n('presence_touch'), 2, 'a write is never shared');
  const before = e.ss.getItem('bp_swr:trialorg'); assert.ok(before);
  await f(U + 'quotes?select=id', H); await f(U + 'rpc/presence_list', post()); await f(U + 'rpc/bell_feed', post('', '{"p_limit":10}'));
  await f(U + 'rpc/presence_touch', post());
  await f(U + 'quotes?select=id', H); await f(U + 'rpc/presence_list', post()); await f(U + 'rpc/bell_feed', post('', '{"p_limit":10}'));
  assert.deepEqual([n('quotes?'), n('presence_list'), n('bell_feed')], [1, 2, 1], 'heartbeat: only the who-is-online read is asked again');
  await f(U + 'rpc/link_views_attention', post());
  await f(U + 'quotes?select=id', H); await f(U + 'rpc/bell_feed', post('', '{"p_limit":10}'));
  assert.deepEqual([n('quotes?'), n('bell_feed')], [1, 2], 'link sweep: the bell (new notification) is asked again, quotes are not');
  assert.equal(e.ss.getItem('bp_swr:trialorg'), before, 'per-tab trial answer kept');
  await f(U + 'rpc/save_quote', post());
  assert.equal(e.ss.getItem('bp_swr:trialorg'), null, 'a real write still drops the per-tab caches');
  await f(U + 'quotes?select=id', H); assert.equal(n('quotes?'), 2, 'and every shared read');
});
t('asset pins: every page asks for store-api.js?v=397', () => {
  const pages = readdirSync(new URL('public/', ROOT)).filter((f) => f.endsWith('.html'));
  let n = 0;
  for (const f of pages) { const m = read('public/' + f).match(/store-api\.js\?v=(\d+)/g); if (!m) continue; n++; for (const x of m) assert.equal(x, 'store-api.js?v=397', f); }
  assert.ok(n >= 50, String(n));
});

let pass = 0, fail = 0;
for (const [name, fn] of tests) {
  try { await fn(); pass++; console.log('  ok ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n' + (e && e.stack || e)); }
}
console.log(`r219-bootstrap-live: ${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
