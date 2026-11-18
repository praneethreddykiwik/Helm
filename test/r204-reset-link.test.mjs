// R204 - a "Forgot password?" link must always open "Set a new password" (New + Confirm, no current password).
//
// In plain words: on prod the reset e-mail link opens /auth/confirm, which verifies the one-time token with
// supabase.auth.verifyOtp(). Supabase signs THAT session amr "otp" (only the old ?code= link gives "recovery"),
// and the reset page only trusted "recovery" - so it treated the person as an ordinary signed-in user and showed
// "Change your password - first confirm your current password". A ?code= link that this browser could not use
// (another browser / already used) while some account was signed in here did the same. Now:
//   - verifyEmailLink(type "recovery") records a one-tab proof bound to that exact session (user id + session_id),
//     and isRecoverySession() accepts an "otp" session only with that proof;
//   - reset-link-core.js decides the screen: a page opened from a reset link never shows the change form;
//     a dead link says why + "Send a new link"; a different account signed in before is named;
//   - /auth/confirm signs a signed-in account out first for a reset link (no "sign out first" stop).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const R = require('../public/reset-link-core.js');
const SRC = read('public/store-api.js');
const tests = [];
const t = (name, fn) => tests.push([name, fn]);

/* ---------------------------------------------------------------- 1. link parsing */
t('parseLink: PKCE ?code=, /auth/confirm ?via=confirm, ?mode=change', () => {
  assert.deepEqual(R.parseLink('?code=abc123', ''), { code: true, viaConfirm: false, modeChange: false, error: '', hashToken: false, hashType: '' });
  assert.equal(R.parseLink('?via=confirm', '').viaConfirm, true);
  assert.equal(R.parseLink('?mode=change', '').modeChange, true);
  assert.equal(R.parseLink('', '').code, false);
});
t('parseLink: hash token (#access_token=…&type=recovery) is noticed, its value never kept', () => {
  const l = R.parseLink('', '#access_token=eyJsecret&refresh_token=r&type=recovery');
  assert.equal(l.hashToken, true); assert.equal(l.hashType, 'recovery');
  assert.ok(!JSON.stringify(l).includes('eyJsecret'));
});
t('parseLink: error_code / error / error_description in the query or the #fragment', () => {
  assert.equal(R.parseLink('?error=access_denied&error_code=otp_expired', '').error, 'otp_expired');
  assert.equal(R.parseLink('', '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid').error, 'otp_expired');
  assert.equal(R.parseLink('?error_description=Something+odd', '').error, 'link_error', 'a description alone counts; its text is not kept');
  assert.equal(R.parseLink('?error_code=<script>', '').error, 'link_error', 'odd shapes are reduced to a fixed code');
});

/* ---------------------------------------------------------------- 2. branching */
const U = { id: 'u-1', email: 'a@studio.test' };
const OTHER = { id: 'u-9', email: 'b@other.test' };
const dec = (o) => R.decide(Object.assign({ link: R.parseLink('', ''), linkError: '', user: null, recovery: false, prior: null, pendingStep: null, hasPassword: true }, o));
t('recovery session (via /auth/confirm or ?code=) → "set" - never the current-password form', () => {
  assert.equal(dec({ link: R.parseLink('?via=confirm', ''), user: U, recovery: true }).view, 'set');
  assert.equal(dec({ link: R.parseLink('?code=x', ''), user: U, recovery: true }).view, 'set');
  assert.equal(dec({ user: U, recovery: true, pendingStep: 'recovery' }).view, 'set', 'reload after the address bar was cleaned');
  assert.equal(dec({ link: R.parseLink('?mode=change', ''), user: U, recovery: true }).view, 'set');
});
t('existing session: same account → no notice; a DIFFERENT account before the link → named', () => {
  assert.equal(dec({ link: R.parseLink('?code=x', ''), user: U, recovery: true, prior: { id: 'u-1', email: 'a@studio.test' } }).switchedFrom, '');
  assert.equal(dec({ link: R.parseLink('?code=x', ''), user: U, recovery: true, prior: OTHER }).switchedFrom, 'b@other.test');
  assert.equal(dec({ link: R.parseLink('?via=confirm', ''), user: U, recovery: true, prior: { email: 'B@other.test' } }).switchedFrom, 'B@other.test');
  assert.equal(dec({ link: R.parseLink('?via=confirm', ''), user: U, recovery: true, prior: { email: 'A@studio.test' } }).switchedFrom, '', 'e-mail compare ignores case');
});
t('THE R204 BUG: a reset link + an ordinary session (not a reset session) never shows "change"', () => {
  // ?code= this browser could not exchange (other browser / used) while some account was signed in here
  assert.equal(dec({ link: R.parseLink('?code=x', ''), user: OTHER, recovery: false }).view, 'wrong_browser');
  assert.equal(dec({ link: R.parseLink('?code=x', ''), user: U, recovery: false }).view, 'wrong_browser');
  // /auth/confirm hand-over without a reset session
  assert.equal(dec({ link: R.parseLink('?via=confirm', ''), user: U, recovery: false }).view, 'expired');
  // no session at all
  assert.equal(dec({ link: R.parseLink('?code=x', ''), linkError: 'pkce_exchange_failed' }).view, 'wrong_browser');
});
t('expired / used link (query, fragment, or /auth/confirm error_code) → "expired"', () => {
  assert.equal(dec({ link: R.parseLink('?via=confirm&error_code=otp_expired', '') }).view, 'expired');
  assert.equal(dec({ link: R.parseLink('', '#error=access_denied&error_code=otp_expired'), user: U }).view, 'expired', 'even when signed in');
  assert.equal(dec({ linkError: 'otp_expired' }).view, 'expired');
  assert.equal(dec({ link: R.parseLink('?via=confirm&error_code=link_failed', '') }).view, 'expired');
});
t('hash-token link → "old_link" (tokens in a link are never used: login CSRF)', () => {
  assert.equal(dec({ link: R.parseLink('', '#access_token=a&type=recovery'), user: U }).view, 'old_link');
});
t('no link: signed out → "need_link" / Change password → login; signed in → "change" (current password kept)', () => {
  assert.equal(dec({}).view, 'need_link');
  assert.equal(dec({ link: R.parseLink('?mode=change', '') }).view, 'login_change');
  assert.equal(dec({ user: U, link: R.parseLink('?mode=change', '') }).view, 'change');
  assert.equal(dec({ user: U }).view, 'change');
  assert.equal(dec({ user: U, pendingStep: 'mfa' }).view, 'login');
  assert.equal(dec({ user: U, hasPassword: false }).view, 'google_only');
  const st = dec({ user: U, pendingStep: 'recovery' });
  assert.equal(st.view, 'change'); assert.equal(st.staleRecovery, true, 'a spoofed "recovery" marker is no proof');
});

/* ---------------------------------------------------------------- 3. store-api recovery proof */
const jwt = (c) => ['{"alg":"none"}', JSON.stringify(c)].map((x) => Buffer.from(x).toString('base64url')).join('.') + '.sig';
function mem(init) { const m = new Map(Object.entries(init || {})); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; }, _m: m }; }
function env(o = {}) {
  const calls = [];
  let now = Date.UTC(2026, 10, 18, 9, 0, 0);
  const RealDate = Date;
  class FakeDate extends RealDate { constructor(...a) { if (a.length) super(...a); else super(now); } static now() { return now; } }
  let session = o.session === undefined ? null : o.session;
  const auth = {
    async getSession() { return { data: { session } }; },
    onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
    async verifyOtp(arg) { calls.push(['verifyOtp', arg]); if (o.verifyError) return { data: {}, error: o.verifyError }; session = o.verifySession; return { data: { user: session.user, session }, error: null }; },
    async signOut(arg) { calls.push(['signOut', arg || null]); if (!arg || arg.scope !== 'others') session = null; return { error: null }; },
    async updateUser(arg) { calls.push(['updateUser', arg]); return { data: {}, error: null }; },
    async refreshSession() { return { data: { session }, error: null }; },
    mfa: { async getAuthenticatorAssuranceLevel() { return { data: { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null }; }, async listFactors() { return { data: { all: [] }, error: null }; } },
  };
  const client = { auth, async rpc() { return { data: null, error: null }; }, from() { const q = { select: () => q, eq: () => q, order: () => q, single: async () => ({ data: { role: 'sales' }, error: null }) }; return q; } };
  const loc = { pathname: o.path || '/reset-password', search: o.search || '', hash: o.hash || '', origin: 'https://www.helm.events', href: '', hostname: 'www.helm.events', replace(u) { calls.push(['location.replace', u]); }, reload() {} };
  const doc = { readyState: 'loading', addEventListener() {}, removeEventListener() {}, currentScript: { src: 'https://www.helm.events/store-api.js?v=1' },
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, addEventListener() {}, querySelector: () => null, remove() {} }),
    head: { appendChild() {} }, body: { appendChild() {}, insertBefore() {} }, documentElement: { setAttribute() {}, getAttribute() { return 'light'; } },
    querySelector: () => null, querySelectorAll: () => [], getElementById: () => null, hidden: false };
  const win = { SUPABASE_CONFIG: { url: 'https://abcdefghijklmnopqrst.supabase.co', anonKey: 'anon' }, supabase: { createClient: () => client },
    localStorage: mem(o.ls), sessionStorage: mem(o.ss), location: loc, history: { replaceState(a, b, u) { calls.push(['replaceState', u]); } }, document: doc, navigator: { onLine: true },
    fetch: async () => ({ status: 200, ok: true, json: async () => ({}) }), addEventListener() {}, removeEventListener() {},
    setTimeout: (fn) => { try { fn(); } catch (e) {} return 0; }, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    atob: (b) => Buffer.from(b, 'base64').toString('binary'),
    console, Date: FakeDate, Promise, URLSearchParams, URL, JSON, Math, Object, Array, String, Number, RegExp, Error, Map, Set };
  win.window = win; win.globalThis = win;
  vm.createContext(win); vm.runInContext(SRC, win, { filename: 'store-api.js' });
  return { win, S: win.BPStore, calls, advance: (ms) => { now += ms; } };
}
const OTP_SESS = { user: U, access_token: jwt({ sub: 'u-1', session_id: 'sess-A', amr: [{ method: 'otp', timestamp: 1 }] }) };
const OTP_SESS_B = { user: U, access_token: jwt({ sub: 'u-1', session_id: 'sess-B', amr: [{ method: 'otp', timestamp: 1 }] }) };
const PW_SESS = { user: U, access_token: jwt({ sub: 'u-1', session_id: 'sess-P', amr: [{ method: 'password', timestamp: 1 }] }) };

t('/auth/confirm reset link (verifyOtp → amr "otp") IS a reset session in this tab; updatePassword sends no current password', async () => {
  const e = env({ path: '/auth-confirm', verifySession: OTP_SESS });
  await e.S.init();
  await e.S.auth.verifyEmailLink('pkce_abcdef0123456789', 'recovery');
  assert.equal(await e.S.auth.isRecoverySession(), true);
  await e.S.auth.updatePassword('Brand-new-pass12!');
  assert.deepEqual(JSON.parse(JSON.stringify(e.calls.find((c) => c[0] === 'updateUser')[1])), { password: 'Brand-new-pass12!' });
  assert.deepEqual(e.calls.filter((c) => c[0] === 'signOut').map((c) => c[1] && c[1].scope), ['others'], 'other sessions signed out, this one kept');
  assert.equal(await e.S.auth.isRecoverySession(), false, 'the link is used up after the new password is saved');
});
t('the proof is bound to THAT session: another otp session, a password session, another tab or >1h → no', async () => {
  const proof = (sid, at) => ({ bp_recovery_link: JSON.stringify({ uid: 'u-1', sid, at: at ?? Date.UTC(2026, 10, 18, 9, 0, 0) }) });
  let e = env({ session: OTP_SESS_B, ss: proof('sess-A') }); await e.S.init();
  assert.equal(await e.S.auth.isRecoverySession(), false, 'different session_id');
  e = env({ session: PW_SESS, ss: proof('sess-P') }); await e.S.init();
  assert.equal(await e.S.auth.isRecoverySession(), false, 'a password sign-in never counts');
  e = env({ session: OTP_SESS }); await e.S.init();
  assert.equal(await e.S.auth.isRecoverySession(), false, 'no proof in this tab (e.g. an e-mail sign-in link)');
  e = env({ session: OTP_SESS, ss: proof('sess-A', Date.UTC(2026, 10, 18, 7, 0, 0)) }); await e.S.init();
  assert.equal(await e.S.auth.isRecoverySession(), false, 'older than an hour');
  e = env({ session: OTP_SESS, ss: proof('sess-A') }); await e.S.init();
  assert.equal(await e.S.auth.isRecoverySession(), true);
  const x = env({ session: PW_SESS }); await x.S.init();
  await assert.rejects(x.S.auth.updatePassword('Brand-new-pass12!'), (err) => err.code === 'reauth_required', 'an ordinary session still needs the current password');
});
t('invite / magic link verified the same way does NOT become a reset session', async () => {
  const e = env({ path: '/auth-confirm', verifySession: OTP_SESS });
  await e.S.init();
  await e.S.auth.verifyEmailLink('abcdef0123456789', 'magiclink');
  assert.equal(await e.S.auth.isRecoverySession(), false);
});
t('old ?code= link: amr "recovery" still works; an account stored before the link is reported (id + e-mail only)', async () => {
  const stored = { 'sb-abcdefghijklmnopqrst-auth-token': JSON.stringify({ access_token: 'old', refresh_token: 'r', user: { id: 'u-9', email: 'b@other.test', phone: '1' } }) };
  const e = env({ search: '?code=abc', ls: stored, session: { user: U, access_token: jwt({ sub: 'u-1', amr: [{ method: 'recovery', timestamp: 1 }] }) } });
  await e.S.init();
  assert.equal(await e.S.auth.isRecoverySession(), true);
  assert.deepEqual(JSON.parse(JSON.stringify(e.S.auth.linkPriorUser())), { id: 'u-9', email: 'b@other.test' });
});
t('a #access_token= link is stripped from the address bar and only its type is kept', async () => {
  const e = env({ hash: '#access_token=eyJsecret&refresh_token=r&type=recovery', session: PW_SESS });
  await e.S.init();
  assert.equal(e.S.auth.linkFragmentToken(), 'recovery');
  assert.ok(e.calls.some((c) => c[0] === 'replaceState' && !String(c[1]).includes('access_token')));
  assert.equal(await e.S.auth.isRecoverySession(), false);
});

/* ---------------------------------------------------------------- 4. page wiring */
t('reset page: core loaded before reset-password.js; "Send a new link" button; no "?code= alone" trust', () => {
  const html = read('public/reset-password.html'), js = read('public/reset-password.js');
  assert.ok(html.indexOf('reset-link-core.js') > 0 && html.indexOf('reset-link-core.js') < html.indexOf('reset-password.js?'));
  assert.match(html, /id="newLink" href="login#forgot">Send a new link/);
  assert.match(html, /id="note"/);
  assert.match(js, /R\.decide\(/);
  assert.ok(!/location\.hash/.test(js), 'the fragment is left to store-api');
  assert.match(js, /linkFragmentToken\(\)\) LINK\.hashToken = true/);
  assert.match(js, /recovery: realRecovery/);
  assert.match(js, /"Set a new password"/);
  // after a reset: other sessions are signed out by updatePassword, and the page goes into the app (no sign-out)
  const ok = js.slice(js.indexOf('if (recovering) {', js.indexOf('updatePassword(a, opts)')));
  assert.match(ok.slice(0, 600), /location\.replace\("login"\)/);
  assert.ok(!/signOut\(\)/.test(ok.slice(0, 600)));
});
t('/auth/confirm: a reset link signs a signed-in account out first and hands its e-mail to the reset page', () => {
  const js = read('public/auth-confirm.js');
  const i = js.indexOf('if (cur && link.type === "recovery")');
  assert.ok(i > 0 && i < js.indexOf('You\'re already signed in'));
  const blk = js.slice(i, i + 700);
  assert.match(blk, /bp_reset_prev/); assert.match(blk, /signOut\(\)/); assert.match(blk, /verify\(\)/);
});

let n = 0;
for (const [name, fn] of tests) {
  try { await fn(); n++; console.log('ok -', name); }
  catch (e) { console.error('not ok -', name); console.error(e); process.exitCode = 1; }
}
console.log(`\nr204-reset-link: ${n}/${tests.length} passed`);
if (n !== tests.length) process.exit(1);
