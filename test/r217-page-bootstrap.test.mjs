// r217-page-bootstrap.test.mjs - R217 (0389, PAGE-SPEED-REPORT 18 Nov 2026): a signed-in page gets its startup reads
// (studio, sign-in steps, role + access switches, trial / demo / test studio / plan) from ONE page_bootstrap() request.
//   1. every helper answers the SAME with the one request as with the old separate calls (sales / planner / admin /
//      client / custom switches), and the separate calls are not sent
//   2. fallback: page_bootstrap not installed (404 PGRST202 - not asked again in this tab), errors (500), never answers
//      (timeout), a garbled answer, a failed part -> the old separate calls, unchanged answers
//   3. gate rules kept: a temporary password / no studio / a pending two-step code / a reset link / a changed studio /
//      the per-tab TTLs (all fresh -> nothing asked at all)
//   4. request count + trips in a row, before / after, with a 250 ms-like latency (scaled)
//   5. 0389 + APPLY-0389 + MANIFEST + checker + run-all + release lists + store-api.js?v=397 pins
// Behaviour of 0389 against the real database: tests/db/r217-page-bootstrap-0389.sql.
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
    readyState: 'complete', addEventListener() {}, removeEventListener() {}, currentScript: { src: 'https://www.helm.events/store-api.js?v=398' },
    createElement: el, head: { appendChild() {} }, body: { children: [], appendChild(c) { this.children.push(c); }, removeChild() {}, get firstChild() { return null; } },
    documentElement: { setAttribute() {}, getAttribute() { return 'light'; },
      classList: { contains: (c) => cls.has(c), add: (c) => { cls.add(c); }, remove: (c) => { cls.delete(c); } } },
    querySelector: () => null, querySelectorAll: () => [], getElementById: () => null, visibilityState: 'visible', hidden: false,
  };
  const ls = o.ls || memStore(), ss = o.ss || memStore();
  const win = {
    SUPABASE_CONFIG: { url: 'https://abcdefghijklmnopqrst.supabase.co', anonKey: 'anon' },
    supabase: { createClient: () => client },
    localStorage: ls, sessionStorage: ss, location: loc, document: doc, navigator: { onLine: true },
    fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),
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
  return { win, S, calls, ss, ls, gated: () => cls.has('auth-pending'), peak: () => peak,
    names: () => calls.map((c) => c.name), net: () => calls.filter((c) => !c.name.startsWith('location.')),
    replaced: () => calls.filter((c) => c.name.startsWith('location.replace:')).map((c) => c.name.slice(17)),
    reset() { calls.length = 0; peak = 0; t0 = Date.now(); } };
}
// what the shell + page ask right after the page shows (auth-ui chrome + the page's access checks)
async function pageReads(S) {
  const safe = (f) => Promise.resolve().then(f).catch((e) => 'ERR ' + ((e && e.code) || ''));
  const [view, viewFin, edit, editLeads, assign, can, trialOrg, trial, demo, sub, test, prof, role, pricing, rates] = await Promise.all([
    () => S.auth.canView('leads'), () => S.auth.canView('finance'), () => S.auth.canEditArea('quotes'), () => S.auth.canEditArea('leads'), () => S.auth.canAssignTasks(),
    () => S.auth.can('create'), () => S.trialOrg.status(), () => S.subscription.trial(), () => S.demo.status(), () => S.subscription.mine(), () => S.auth.mfa.testStudio(),
    () => S.profile.status(), () => S.auth.role(), () => S.config.getPricing(), () => S.config.itemRates()].map(safe));
  return { view, viewFin, edit, editLeads, assign, can, trialOrg, trial, demo, sub, test, prof, role, pricing, rates, cached: S.auth.cachedRole() };
}
const trips = (calls) => { // trips in a row = distinct LAT-wide time slots the requests started in
  const starts = calls.map((c) => c.at).sort((a, b) => a - b); let n = 0, last = -Infinity;
  for (const s of starts) if (s >= last + LAT * 0.8) { n++; last = s; }
  return n;
};
async function run(o) {
  const e = makeEnv(o); const t0 = Date.now();
  // a page that sends the person elsewhere (sign-in, profile, checkout, no studio) never finishes init (HANG): wait a moment instead
  const mode = await Promise.race([e.S.init(), new Promise((r) => setTimeout(() => r('hang'), 400))]);
  const shown = !e.gated();
  const reads = shown ? await pageReads(e.S) : null;
  // the studio row (organizations?id=eq.<studio>, studio link name) stays its own read on purpose: a fresh read also
  // announces the studio to the page (helm:studio event + time zone), which a cached answer would skip
  const net = e.net(), names = net.map((c) => c.name).filter((n) => !KEPT.includes(n));
  return { e, mode, shown, reads, ms: Date.now() - t0, net, all: net.map((c) => c.name), names };
}
const KEPT = ['from:organizations'];
const OLD = ['current_org_id', 'my_profile_status', 'my_checkout_status', 'password_change_required', 'from:profiles', 'from:role_access',
  'my_trial_org', 'my_trial_status', 'my_demo_status', 'my_subscription', 'my_test_studio', 'get_pricing_config', 'get_item_rate_cards'];

/* ---------------------------------------------------------- 1. same answers, one request */
for (const [label, o] of [
  ['sales (default switches)', { role: 'sales' }],
  ['planner with custom switches (finance on, quotes edit off)', { role: 'planner', rows: [{ area: 'finance', can_view: true, can_edit: false }, { area: 'quotes', can_view: true, can_edit: false }, { area: 'tasks', can_view: true, can_edit: true }, { area: 'staff', can_view: true, can_edit: false }, { area: 'quote_create', can_view: true, can_edit: false }] }],
  ['admin', { role: 'admin', rows: [] }],
  ['supervisor in a test studio on a free trial', { role: 'supervisor', testStudio: true, trial: { status: 'trial', state: 'trial', days_left: 5 }, trialOrg: { is_trial_org: true, read_only: false, locked: false, days_left: 5 } }],
  ['coordinator in a studio read-only after its trial', { role: 'coordinator', readOnly: true }],
]) {
  t(`${label}: one page_bootstrap request; every helper answers exactly as with the separate calls`, async () => {
    const neu = await run(o), old = await run({ ...o, boot: 'missing' });
    assert.equal(neu.mode, 'supabase'); assert.equal(neu.shown, true); assert.equal(old.shown, true);
    assert.deepEqual(neu.reads, old.reads);
    assert.deepEqual(neu.names, ['page_bootstrap'], 'only the one request: ' + neu.names.join(', '));
    for (const n of OLD) assert.ok(old.names.includes(n), 'fallback asks ' + n);
    assert.equal(neu.e.S.auth._bootstrap.used(), true); assert.equal(old.e.S.auth._bootstrap.used(), false);
  });
}
t('a client login: the role + access answers equal the old reads (client rows only)', async () => {
  const o = { role: 'client', rows: [{ area: 'portal', can_view: true, can_edit: false }] };
  const neu = makeEnv(o), old = makeEnv({ ...o, boot: 'missing' });
  await neu.S.init(); await old.S.init();
  for (const e of [neu, old]) assert.equal(await e.S.auth.role(), 'client');
  assert.equal(await neu.S.auth.canView('portal'), await old.S.auth.canView('portal'));
  assert.equal(await neu.S.auth.canView('leads'), await old.S.auth.canView('leads'));
});
t('the per-tab caches page_bootstrap fills are the SAME keys + values the old calls write', async () => {
  const neu = await run({ role: 'planner' }), old = await run({ role: 'planner', boot: 'missing' });
  for (const k of ['bp_sess_org', 'bp_sess_role', 'bp_sess_access', 'bp_sess_profile', 'bp_sess_checkout', 'bp_swr:trialorg', 'bp_swr:trial', 'bp_swr:demo', 'bp_swr:pricing', 'bp_swr:rates']) {
    const a = JSON.parse(neu.e.ss.getItem(k)), b = JSON.parse(old.e.ss.getItem(k));
    assert.ok(a && b, k); assert.deepEqual(a.val, b.val, k); assert.equal(a.uid, b.uid, k);
    if (b.oid) assert.equal(a.oid, b.oid, k);
  }
  assert.equal(neu.e.ss.getItem('bp_pw_ok'), old.e.ss.getItem('bp_pw_ok'));
});

/* ---------------------------------------------------------- 2. fallback */
t('page_bootstrap not installed (404 PGRST202): old calls, page shows; the next page in this tab does not ask it again', async () => {
  const a = await run({ boot: 'missing' });
  assert.equal(a.shown, true); assert.equal(a.names[0], 'page_bootstrap');
  assert.ok(a.e.ss.getItem('bp_boot_missing'));
  // next page in the same tab, caches expired: page_bootstrap is skipped (noted missing), the old calls run
  const ss = a.e.ss; for (const k of ['bp_sess_org', 'bp_sess_role', 'bp_sess_access']) ss.removeItem(k);
  const b = await run({ boot: 'ok', ss });
  assert.ok(!b.names.includes('page_bootstrap'), 'skipped while noted missing');
  assert.ok(b.names.includes('current_org_id') && b.names.includes('from:role_access'));
});
t('page_bootstrap errors (500): old calls, same answers, not noted as missing', async () => {
  const a = await run({ boot: 'error', role: 'planner' }), b = await run({ boot: 'missing', role: 'planner' });
  assert.equal(a.shown, true); assert.deepEqual(a.reads, b.reads);
  assert.equal(a.e.ss.getItem('bp_boot_missing'), null);
  for (const n of OLD) assert.ok(a.names.includes(n), n);
});
t('page_bootstrap never answers: after the deadline the old calls run, page shows with the same answers', async () => {
  const a = await run({ boot: 'hang', role: 'sales' }), b = await run({ boot: 'missing', role: 'sales' });
  assert.equal(a.shown, true); assert.deepEqual(a.reads, b.reads);
  for (const n of OLD) assert.ok(a.names.includes(n), n);
});
t('a garbled answer (no v:1 / parts not an object) is ignored: old calls', async () => {
  const a = await run({ boot: 'garbled' });
  assert.equal(a.shown, true); assert.ok(a.names.includes('current_org_id') && a.names.includes('from:profiles'));
});
t('a part the server could not answer (listed under errors) is asked the old way; the rest come from the one request', async () => {
  const a = await run({ failParts: ['my_trial_org'] });
  assert.equal(a.shown, true);
  assert.deepEqual(a.names.sort(), ['my_trial_org', 'page_bootstrap']);
});

/* ---------------------------------------------------------- 3. gate rules kept */
t('temporary password: page_bootstrap says yes -> the old check confirms -> sign-in page, never the app', async () => {
  const a = await run({ pw: true, org: null });
  assert.equal(a.shown, false); assert.deepEqual(a.e.replaced(), ['/login?next=dashboard']);
  assert.ok(a.names.includes('password_change_required'), 'a "yes" is never cached - asked again as before');
  assert.equal(a.e.ss.getItem('bp_sess_role'), null, 'no role / access cached for a pending step');
});
t('two-step code pending (aal1 with a factor): sign-in page, no role / access cached from page_bootstrap', async () => {
  const a = await run({ mfaPending: true, org: null });
  assert.equal(a.shown, false); assert.deepEqual(a.e.replaced(), ['/login?next=dashboard']);
  assert.equal(a.e.ss.getItem('bp_sess_role'), null); assert.equal(a.e.ss.getItem('bp_sess_access'), null);
  assert.equal(a.e.ss.getItem('bp_pw_ok'), null);
});
t('no studio: routed like before; page_bootstrap caches nothing the old calls would not (no studio, no trial / pricing caches)', async () => {
  const a = await run({ org: null }), b = await run({ org: null, boot: 'missing' });
  assert.equal(a.shown, false); assert.deepEqual(a.e.replaced(), b.e.replaced());
  assert.ok(a.e.replaced().some((u) => /^\/login\?next=/.test(u)));
  for (const k of ['bp_sess_org', 'bp_swr:trialorg', 'bp_swr:pricing', 'bp_swr:rates']) assert.equal(a.e.ss.getItem(k), null, k);
  // role / access: page_bootstrap leaves them to the old reads (only inside a studio) - same values as before
  for (const k of ['bp_sess_role', 'bp_sess_access']) {
    const x = a.e.ss.getItem(k), y = b.e.ss.getItem(k);
    assert.deepEqual(x && JSON.parse(x).val, y && JSON.parse(y).val, k);
  }
});
t('a reset link waiting for its new password: the "no temporary password" answer is not remembered', async () => {
  const ls = memStore({ bp_recovery_pending: 'u-1' });
  const a = await run({ ls });
  assert.equal(a.shown, false); assert.equal(a.e.ss.getItem('bp_pw_ok'), null);
});
t('profile must be completed: sent to /profile-setup (the "must" answer is not cached, as before)', async () => {
  const a = await run({ profile: { complete: false, required: true, nudge: false } });
  assert.equal(a.shown, false); assert.ok(a.e.replaced().some((u) => u.startsWith('/profile-setup?next=')));
  assert.equal(a.e.ss.getItem('bp_sess_profile'), null);
  assert.deepEqual(a.names, ['page_bootstrap']);
});
t('owner must pick a plan: sent to /checkout (not cached)', async () => {
  const a = await run({ role: 'admin', checkout: { required: true, is_admin: true, reason: 'new_studio' } });
  assert.equal(a.shown, false); assert.ok(a.e.replaced().some((u) => u.startsWith('/checkout?next=')));
  assert.equal(a.e.ss.getItem('bp_sess_checkout'), null);
});
t('the studio changed since this tab cached it: the tab caches are dropped, the page uses the new studio', async () => {
  const ss = memStore({ bp_sess_org: entry('u-1', 'org-OLD', 5 * 60000), 'bp_swr:pricing': JSON.stringify({ ts: Date.now(), uid: 'u-1', oid: 'org-OLD', val: { x: 1 } }) });
  const a = await run({ ss });
  assert.equal(a.shown, true);
  assert.equal(JSON.parse(ss.getItem('bp_sess_org')).val, ORG);
  const pr = JSON.parse(ss.getItem('bp_swr:pricing'));
  assert.ok(!pr || pr.oid === ORG, "the old studio's cached pricing is gone (only the new studio's answer)");
});
t('TTL kept: every startup answer fresh in this tab -> nothing is asked at all (not even page_bootstrap)', async () => {
  const a = await run({});
  const b = await run({ ss: a.e.ss });
  assert.equal(b.shown, true);
  // my_subscription has no tab cache and my_test_studio is kept per page (60 s) - both asked on every page, as before
  assert.deepEqual(b.names.filter((n) => n !== 'my_subscription' && n !== 'my_test_studio'), [], b.names.join(', '));
});
t('TTL kept: role / access older than a minute -> one page_bootstrap brings the live switches (rbac-1030)', async () => {
  const ss = memStore({ bp_sess_org: entry('u-1', ORG, 1000), bp_pw_ok: 'u-1',
    bp_sess_profile: entry('u-1', { complete: true, required: false, nudge: false }, 1000), bp_sess_checkout: entry('u-1', { required: false, reason: 'subscribed' }, 1000),
    bp_sess_role: entry('u-1', 'sales', 2 * 60000), bp_sess_access: entry('u-1', { role: 'sales', map: { leads: { view: true, edit: true } } }, 2 * 60000) });
  const a = await run({ ss, role: 'planner', rows: [{ area: 'leads', can_view: false, can_edit: false }] });
  assert.equal(a.names[0], 'page_bootstrap');
  assert.equal(a.reads.role, 'planner'); assert.equal(a.reads.view, false);
});
t('bootNeeded / parse / access are pure', () => {
  const e = makeEnv({}); const B = e.S.auth._bootstrap;
  assert.equal(B.needed('u-1', memStore()), true);
  const fresh = memStore({ bp_sess_org: entry('u-1', ORG, 1000), bp_pw_ok: 'u-1', bp_sess_profile: entry('u-1', { complete: true }, 9 * 60000),
    bp_sess_checkout: entry('u-1', { required: false }, 9 * 60000), bp_sess_role: entry('u-1', 'sales', 1000), bp_sess_access: entry('u-1', { role: 'sales', map: {} }, 1000) });
  // R219: the trial / demo / pricing / rate-card answers count too (fresh = young enough that swr would not re-ask them)
  const swrE = (age, oid = ORG) => JSON.stringify({ ts: Date.now() - age, uid: 'u-1', oid, val: {} });
  for (const n of ['trialorg', 'trial', 'demo', 'pricing', 'rates']) fresh.setItem('bp_swr:' + n, swrE(1000));
  assert.equal(B.needed('u-1', fresh), false);
  fresh.setItem('bp_swr:demo', swrE(25000)); assert.equal(B.needed('u-1', fresh), true, 'an answer swr would re-check -> one page_bootstrap');
  fresh.setItem('bp_swr:demo', swrE(1000, 'org-OTHER')); assert.equal(B.needed('u-1', fresh), true, "another studio's answer never counts");
  fresh.removeItem('bp_swr:demo'); assert.equal(B.needed('u-1', fresh), true, 'a missing answer -> one page_bootstrap');
  fresh.setItem('bp_swr:demo', swrE(1000));
  assert.equal(B.needed('u-2', fresh), true, "another user's caches never count");
  assert.equal(B.parse(null), null); assert.equal(B.parse({ parts: {} }), null); assert.equal(B.parse({ v: 1, parts: [] }), null);
  assert.deepEqual(JSON.parse(JSON.stringify(B.parse({ v: 1, parts: { a: 1 } }))), { a: 1 });
  assert.deepEqual(JSON.parse(JSON.stringify(B.access('sales', [{ area: 'leads', can_view: true, can_edit: 0 }, null, { area: 5 }]))), { role: 'sales', map: { leads: { view: true, edit: false } } });
  assert.equal(B.access('sales', null), null);
});

/* ---------------------------------------------------------- 4. request count + trips (printed for the PR) */
t('before / after: requests at startup and trips in a row (dashboard-like page, fresh tab)', async () => {
  const before = await run({ boot: 'missing' }), after = await run({});
  // the browser merges identical reads that start within 1.5 s into one request (coalescedFetch): count distinct ones
  const nb = [...new Set(before.all.filter((n) => n !== 'page_bootstrap'))], na = [...new Set(after.all)];
  const tb = trips(before.net.filter((c) => c.name !== 'page_bootstrap')), ta = trips(after.net);
  console.log(`    before: ${nb.length} requests, ${tb} trips in a row (${nb.join(', ')})`);
  console.log(`    after : ${na.length} requests, ${ta} trips in a row (${na.join(', ')})`);
  assert.equal(after.names.length, 1); assert.ok(nb.length >= 13, String(nb.length)); assert.ok(tb >= 3, 'old: gate + role + access in a row = ' + tb); assert.ok(ta < tb, ta + ' < ' + tb);
});

/* ---------------------------------------------------------- 5. wiring */
const MIG = read('supabase/migrations/0389_r217_page_bootstrap.sql'), APPLY = read('supabase/APPLY-0389.sql');
t('0389: one stable definer function, empty search_path, authenticated only, the r217-0389 marker; read-only + additive', () => {
  assert.match(MIG, /create or replace function public\.page_bootstrap\(\)\nreturns jsonb language plpgsql stable security definer set search_path = '' as \$\$\n-- r217-0389/);
  assert.match(MIG, /revoke all on function public\.page_bootstrap\(\) from public;/);
  assert.match(MIG, /revoke all on function public\.page_bootstrap\(\) from anon/);
  assert.match(MIG, /grant execute on function public\.page_bootstrap\(\) to authenticated/);
  assert.doesNotMatch(MIG, /\b(insert\s+into|update\s+public\.|delete\s+from|drop\s+|truncate|alter\s+table|create\s+policy|create\s+table)\b/i);
  assert.equal((MIG.match(/create or replace function/g) || []).length, 1, 'only page_bootstrap');
  for (const f of ['current_org_id', 'my_profile_status', 'my_checkout_status', 'password_change_required', 'my_trial_org', 'my_trial_status', 'my_demo_status', 'my_subscription', 'my_test_studio', 'get_pricing_config', 'get_item_rate_cards', 'user_role'])
    assert.match(MIG, new RegExp('public\\.' + f + '\\(\\)'), f);
  assert.doesNotMatch(MIG, /[^\x00-\x7F]/, 'ASCII only');
});
t('APPLY-0389: begin + the migration + all-true checks + commit (paste-safe, ASCII)', () => {
  assert.match(APPLY, /^-- APPLY-0389 /); assert.ok(APPLY.includes(MIG.trim()), 'the whole migration inside');
  assert.match(APPLY, /\nbegin;\n/); assert.match(APPLY, /select item, ok from \(values\n[\s\S]*\) v\(item, ok\) order by item;\ncommit;\n$/);
  assert.doesNotMatch(APPLY, /create temp|temporary table|^\\/im);
  assert.doesNotMatch(APPLY, /[^\x00-\x7F]/, 'ASCII only');
  for (const w of ['read-only', 'definer', 'search_path', 'anon', 'unchanged']) assert.match(APPLY, new RegExp(w), w);
});
t('MANIFEST + checker overrides + generated checker + run-all + release lists know 0389', () => {
  assert.match(read('supabase/migrations/MANIFEST'), /\nforward  supabase\/migrations\/0389_r217_page_bootstrap\.sql\n/);
  const ov = JSON.parse(read('supabase/check-prod-overrides.json'));
  assert.ok(ov['0389'], 'override entry');
  assert.match(read('supabase/CHECK-PROD-MIGRATIONS.sql'), /'0389_r217_page_bootstrap'/);
  assert.match(read('scripts/db-test/run-all.sh'), /run "r217-page-bootstrap-0389" "R217-PAGE-BOOTSTRAP-0389: ALL PASS \\\(\d+\/\d+\\\)" psql -q -f tests\/db\/r217-page-bootstrap-0389\.sql/);
  for (const f of ['test/release-1019.test.mjs', 'test/release-1020.test.mjs']) assert.match(read(f), /'0389'(, '\d{4}')*\]/, f);
});
t('store-api.js: page_bootstrap counted as a read (never drops the shared caches); the old calls are all still there', () => {
  assert.match(SRC, /const READ_RPCS = \/\\\/rest\\\/v1\\\/rpc\\\/\(page_bootstrap\|current_org_id\|/);
  for (const c of ['supa.rpc("current_org_id")', 'supa.rpc("my_profile_status")', 'supa.rpc("my_checkout_status")', 'supa.rpc("password_change_required")',
    'supa.from("profiles").select("role")', 'supa.from("role_access").select("area,can_view,can_edit")', 'rpc("my_trial_org", {})', 'rpc("my_trial_status")',
    'rpc("my_demo_status")', 'rpc("my_subscription")', 'supa.rpc("my_test_studio")', 'rpc("get_pricing_config")', 'rpc("get_item_rate_cards")']) assert.ok(SRC.includes(c), 'old call kept: ' + c);
});
t('asset pin: every page that loads store-api.js asks for v=396', () => {
  const pages = readdirSync(new URL('public/', ROOT)).filter((f) => f.endsWith('.html'));
  let n = 0;
  for (const f of pages) { const h = read('public/' + f); const m = h.match(/store-api\.js\?v=(\d+)/g); if (!m) continue; n++; for (const x of m) assert.equal(x, 'store-api.js?v=398', f); }
  assert.ok(n >= 50, String(n));
});

let pass = 0, fail = 0;
for (const [name, fn] of tests) {
  try { await fn(); pass++; console.log('  ok ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n' + (e && e.stack || e)); }
}
console.log(`r217-page-bootstrap: ${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
