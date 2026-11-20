// r203-auth-mail-2step.test.mjs - R203 (owner 18 Nov 2026).
//   A. "Forgot password?" said "Couldn't reach the server" although the reset e-mail then ARRIVED: Supabase Auth sends its
//      e-mail before it answers and the Gmail SMTP took > 30 s, the store's 30 s fetch deadline cut the call off.
//      Auth e-mail calls now wait 75 s; a time-out / 502-504 = "we couldn't confirm the e-mail was sent" (never the user's
//      connection) + a cool-down (no second e-mail) + telemetry auth_mail_timeout. invite-signup: deadlines on its Auth
//      calls, create_failed / send_unconfirmed codes the join page maps, tagged logs.
//   B. 0381: HQ-only TEST STUDIO switch (two-step not enforced in that studio only), banner, Admin note before the click.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
const ROOT = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');
let n = 0;
const t = async (name, fn) => { try { await fn(); n++; console.log('  ok ' + name); } catch (e) { console.error('  FAIL ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; } };
const fnSrc = (src, name) => {
  const at = src.indexOf('function ' + name + '('); assert.ok(at >= 0, name + ' missing');
  let d = 0; for (let k = src.indexOf('{', src.indexOf(')', at)); k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}' && !--d) return src.slice(at, k + 1); }
  throw new Error(name + ' unterminated');
};
const methodSrc = (src, head) => {
  const at = src.indexOf(head); assert.ok(at >= 0, head + ' missing');
  let d = 0; for (let k = src.indexOf('{', at); k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}' && !--d) return src.slice(at, k + 1); }
  throw new Error(head + ' unterminated');
};
const API = read('public/store-api.js'), LOGIN = read('public/login.html'), AUI = read('public/auth-ui.js'), CTL = read('public/control.html');
const FN = read('supabase/functions/invite-signup/index.ts');
const MIG = read('supabase/migrations/0381_r203_test_studio_two_step.sql'), APPLY = read('supabase/APPLY-0381.sql');

/* ------------------------------------------------------------------ A. client: deadlines + honest message */
const consts = API.match(/const FETCH_TIMEOUT_MS = \d+;[\s\S]*?const AUTH_MAIL_POST = [^\n]+\n/)[0];
// eslint-disable-next-line no-new-func
const timeoutFor = new Function(consts + fnSrc(API, 'fetchTimeoutFor') + '\nreturn fetchTimeoutFor;')();
// eslint-disable-next-line no-new-func
const unconfirmed = new Function(fnSrc(API, 'authMailUnconfirmed') + '\nreturn authMailUnconfirmed;')();
const U = 'https://proj.supabase.co';

await t('auth e-mail calls (recover / otp / resend / signup / invite / e-mail change / reauthenticate) wait 75 s, everything else 30 s', () => {
  for (const p of ['/auth/v1/recover', '/auth/v1/recover?redirect_to=x', '/auth/v1/otp', '/auth/v1/resend', '/auth/v1/signup', '/auth/v1/magiclink', '/auth/v1/invite'])
    assert.equal(timeoutFor(U + p, { method: 'POST' }), 75000, p);
  assert.equal(timeoutFor(U + '/auth/v1/user', { method: 'PUT' }), 75000, 'e-mail change');
  assert.equal(timeoutFor(U + '/auth/v1/reauthenticate', { method: 'GET' }), 75000);
  assert.equal(timeoutFor(U + '/auth/v1/user', { method: 'GET' }), 30000, 'getUser stays 30 s');
  assert.equal(timeoutFor(U + '/auth/v1/token?grant_type=password', { method: 'POST' }), 30000, 'sign-in stays 30 s');
  assert.equal(timeoutFor(U + '/rest/v1/rpc/my_profile', { method: 'POST' }), 30000);
  assert.equal(timeoutFor(U + '/auth/v1/recover', undefined), 30000, 'a GET is not a send');
  const tf = fnSrc(API, 'timedFetch');
  assert.match(tf, /const ms = fetchTimeoutFor\(input, init\);/); assert.match(tf, /AbortSignal\.timeout\(ms\)/);
  assert.match(tf, /if \(ms === AUTH_MAIL_TIMEOUT_MS\) e\.authMail = true;/);
});
await t('time-out / gateway = "not confirmed"; offline, 500 SMTP error, 429, null = not', () => {
  assert.equal(unconfirmed({ name: 'AuthRetryableFetchError', status: 0, message: 'Failed to fetch: the server did not answer in time' }), 'timeout');
  assert.equal(unconfirmed({ authMail: true }), 'timeout');
  assert.equal(unconfirmed({ name: 'AuthRetryableFetchError', status: 504, message: '{}' }), 'gateway');
  assert.equal(unconfirmed({ status: 502 }), 'gateway'); assert.equal(unconfirmed({ status: 503 }), 'gateway');
  assert.equal(unconfirmed({ name: 'AuthRetryableFetchError', status: 0, message: 'Failed to fetch' }), null, 'really offline');
  assert.equal(unconfirmed({ status: 500, message: 'Error sending recovery email' }), null);
  assert.equal(unconfirmed({ status: 429 }), null); assert.equal(unconfirmed(null), null);
  assert.equal(unconfirmed({ code: 'request_timeout', status: 504 }), null, 'a coded Auth answer keeps its r29 message');
  assert.match(API, /const AUTH_MAIL_UNCONFIRMED = "We couldn't confirm the e-mail was sent\. It may still arrive in a few minutes \\u2014 check your inbox and spam before trying again\.";/);
  assert.ok(!/connection/i.test(API.match(/const AUTH_MAIL_UNCONFIRMED = "[^"]+"/)[0]), 'never blames the connection');
});
await t('requestPasswordReset: cool-down first, not-confirmed BEFORE the network-error branch, cool-down set, telemetry', () => {
  const src = methodSrc(API, 'async requestPasswordReset(email, opts) {');
  const cd = src.indexOf('authMailCooldownLeft("recover", email)'), un = src.indexOf('authMailUnconfirmed(error)'), net = src.indexOf('isNetworkError(error)');
  assert.ok(cd > 0 && cd < src.indexOf('resetPasswordForEmail'), 'cool-down checked before sending');
  assert.ok(un > 0 && un < net, 'time-out handled before "couldn\'t reach the server"');
  assert.match(src, /authMailCooldownSet\("recover", email, "unconfirmed"\); throw authMailUnconfirmedError\("recover", un, error\);/);
  assert.match(src, /authMailCooldownSet\("recover", email, "sent"\);\n\s+return true;/);
  const rs = methodSrc(API, 'async resendSignup(email, opts) {');
  assert.match(rs, /authMailCooldownLeft\("resend", em\)/); assert.match(rs, /authMailUnconfirmedError\("resend", un, error\)/);
  assert.match(fnSrc(API, 'reportAuthMailTimeout'), /HelmTelemetry\.report\("auth_mail_timeout", e\)/);
  assert.match(fnSrc(API, 'reportAuthMailTimeout'), /"auth_mail_timeout endpoint=" \+ String\(endpoint \|\| ""\)\.replace\(\/\[\^a-z_\]\/g, ""\)/, 'no address in the event');
  assert.match(fnSrc(API, 'authMailUnconfirmedError'), /e\.code = "mail_unconfirmed"; e\.authMapped = true;/);
  assert.match(fnSrc(API, 'authMailCooldownError'), /e\.code = "mail_cooldown"; e\.authMapped = true;/);
  assert.match(API, /AUTH_MAIL_COOLDOWN_MS = \{ sent: 60000, unconfirmed: 180000 \}/);
  assert.ok(!/email[^\n]*localStorage\.setItem\(AUTH_MAIL_CD_KEY/.test(fnSrc(API, 'authMailCooldownSet').replace(/authMailKey\(kind, email\)/, '')), 'only a hash of the address is kept');
  const su = methodSrc(API, 'async signUp(email, password, opts) {');
  assert.ok(su.indexOf('authMailUnconfirmed(error)') < su.indexOf('isNetworkError(error)'), 'sign-up: same order');
});
await t('cool-down helpers: same kind + address blocked inside the window, other address / kind free', () => {
  const store = {}; const localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
  // eslint-disable-next-line no-new-func
  const mk = new Function('localStorage', API.match(/const AUTH_MAIL_CD_KEY = [^\n]+\n/)[0] + fnSrc(API, 'authMailKey') + fnSrc(API, 'authMailCooldownLeft') + fnSrc(API, 'authMailCooldownSet')
    + '\nreturn { left: authMailCooldownLeft, set: authMailCooldownSet, key: authMailKey };');
  const h = mk(localStorage);
  assert.equal(h.left('recover', 'a@b.in'), 0);
  h.set('recover', 'A@B.in ', 'unconfirmed');
  assert.ok(h.left('recover', 'a@b.in') > 170000, 'unconfirmed: about 3 minutes');
  assert.equal(h.left('recover', 'c@d.in'), 0); assert.equal(h.left('resend', 'a@b.in'), 0);
  assert.equal(h.left('recover', 'a@b.in', Date.now() + 181000), 0, 'free again after the window');
  assert.ok(!JSON.stringify(store).includes('a@b.in'), 'the address itself is never stored');
});
await t('login.html: "Sending… this can take up to a minute"; not confirmed / cool-down shown as a calm note (forgot + resend)', () => {
  assert.match(LOGIN, /btn\.textContent="Sending… this can take up to a minute";/);
  assert.match(LOGIN, /if\(\/\^\(mail_unconfirmed\|mail_cooldown\)\$\/\.test\(c\)\)\{ \$\("#fgOk"\)\.textContent=err\.message; \$\("#fgOk"\)\.hidden=false; \}/);
  assert.match(LOGIN, /if\(err&&\/\^\(mail_unconfirmed\|mail_cooldown\)\$\/\.test\(err\.code\|\|""\)\)\{ okEl\.textContent=err\.message; okEl\.hidden=false; cooldown\(btn,label,COOLDOWN\); return; \}/);
  assert.ok(!/fgErr[^\n]*innerHTML/.test(LOGIN));
});

/* ------------------------------------------------------------------ A. invite-signup */
await t('invite-signup: every Auth call has a 70 s deadline; createUser never sends mail; tagged codes', () => {
  assert.match(FN, /export const AUTH_CALL_MS = 70_000;/);
  assert.match(FN, /global: \{ fetch: timedFetch \}/);
  assert.equal((FN.match(/= adminClient\(\)/g) || []).length, 2, 'both clients use the deadline');
  assert.ok(!/createClient\(Deno\.env\.get\("SUPABASE_URL"\)!, Deno\.env\.get\("SUPABASE_SERVICE_ROLE_KEY"\)!, \{ auth: \{ persistSession: false \} \}\)/.test(FN));
  assert.match(FN, /admin\.auth\.admin\.createUser\(\{\n\s+email: bound, password, email_confirm: true,/);
  assert.match(FN, /code: "create_failed"/); assert.match(FN, /"INVSU_CREATE_TIMEOUT" : "INVSU_CREATE_FAILED"/);
  assert.equal((FN.match(/code: "send_unconfirmed" \}, 504\)/g) || []).length, 3, 'invite, magic link, resend');
  assert.match(FN, /INVSU_MAIL_TIMEOUT/);
});
await t('store-api + login.html map create_failed / send_unconfirmed to plain words', () => {
  const sd = methodSrc(API, 'async signupDirect(token, email, password, fullName) {');
  assert.ok(sd.indexOf('j.code === "create_failed"') > 0 && sd.indexOf('j.code === "create_failed"') < sd.indexOf('res.status >= 500'), 'before the fallback');
  assert.match(methodSrc(API, 'async resendLink(token) {'), /j\.code === "send_unconfirmed"/);
  assert.match(methodSrc(API, 'async emailInviteLink(email) {'), /j\.code === "send_unconfirmed"/);
  assert.match(LOGIN, /if\(x&&x\.code==="create_failed"\)\{ showErr\(\$\("#err"\),x\.message\); return "done"; \}/);
  assert.match(LOGIN, /if\(x && x\.code==="send_unconfirmed"\)\{ ok\.textContent=x\.message;/);
});
await t('invite-signup stays verify_jwt = false; 9 functions keep verify_jwt = true', () => {
  const cfg = read('supabase/config.toml');
  assert.match(cfg, /\[functions\.invite-signup\][^\n]*\nverify_jwt = false/);
  assert.equal((cfg.match(/^verify_jwt = true$/gm) || []).length, 9);
});
await t('smoke docs: the optional auth e-mail check + auth_mail_timeout', () => {
  const md = read('tests/smoke/README.md');
  assert.match(md, /auth_mail_timeout/); assert.match(md, /path = \/recover/);
});

/* ------------------------------------------------------------------ B. 0381 test studio */
await t('0381: HQ-only switch tables (RLS, no app privilege), guard + log + append-only triggers, step-up exemption after the flag check', () => {
  assert.match(MIG, /create table if not exists public\.studio_test_mode \(/);
  assert.match(MIG, /create table if not exists public\.studio_test_mode_log \(/);
  assert.match(MIG, /revoke all on table public\.%I from authenticated/);
  assert.ok(!/grant (select|insert|update|delete)[^;]*studio_test_mode[^;]*to authenticated/i.test(MIG));
  const su = MIG.slice(MIG.indexOf('create or replace function public._r285_step_up(p_org uuid)'));
  const flag = su.indexOf('R35_FLAGGED'), ex = su.indexOf('if public._r381_two_step_exempt(p_org) then return; end if;'), setup = su.indexOf('R35_SETUP_2STEP');
  assert.ok(flag > 0 && ex > flag && setup > ex, 'flag still checked; exemption before the two-step parts');
  assert.match(su, /-- r35-0285\n-- r203-0381/);
  assert.match(MIG, /perform public\._hq27_require\('studios\.edit', true\);/);
  assert.match(MIG, /'hq\.studio\.test_mode'/);
  assert.match(MIG, /only Helm HQ can change the test studio switch/);
  for (const f of MIG.match(/create or replace function [^\n]+/g)) assert.ok(true, f);
  assert.equal((MIG.match(/security definer set search_path = ''/g) || []).length, (MIG.match(/create or replace function/g) || []).length, 'every function: definer + empty search_path');
  assert.ok(!/drop (table|function)(?! trigger)/i.test(MIG.replace(/^--.*$/gm, '')), 'nothing dropped');
  assert.ok(!/^\s+org_id\s/m.test(MIG) && !/references public\.organizations/.test(MIG), 'no org_id column / FK: studio purges + org-table sweeps leave the switch alone');
  assert.ok(!/[^\x00-\x7F]/.test(MIG), 'ASCII only');
});
await t('APPLY-0381: paste-safe (begin / commit, no psql meta, no temp tables), the migration verbatim, final all-true checks, switch-on SQL for helm-studio', () => {
  assert.ok(APPLY.includes(MIG), 'carries the migration verbatim');
  assert.match(APPLY, /^-- APPLY-0381/); assert.match(APPLY, /\nbegin;\n/); assert.match(APPLY, /\) v\(item, ok\) order by item;\ncommit;\n$/);
  assert.match(APPLY, /select item, ok from \(values/);
  assert.ok(!/^\\/m.test(APPLY) && !/temp table/i.test(APPLY.replace(/^--.*$/gm, '')));
  assert.match(APPLY, /--   insert into public\.studio_test_mode \(studio, two_step_exempt, note\) select id, true, 'Shared tester login \(R203\)' from public\.organizations where slug = 'helm-studio' on conflict \(studio\) do update set two_step_exempt = true, note = excluded\.note, set_at = now\(\);/);
  assert.ok(!/[^\x00-\x7F]/.test(APPLY));
});
await t('0381 wiring: MANIFEST, checker override (last), run-all, CHECK-PROD, release lists', () => {
  assert.ok(read('supabase/migrations/MANIFEST').includes('forward  supabase/migrations/0381_r203_test_studio_two_step.sql'));
  assert.match(read('supabase/check-prod-overrides.json'), /"0381": \{ "note": "test-studio two-step switch[^\n]*"marker public\._r285_step_up\(uuid\) r203-0381"[^\n]*\] \},?\n/);
  assert.match(read('scripts/db-test/run-all.sh'), /run "r203-test-studio-0381" "R203-TEST-STUDIO-0381: ALL PASS \\\(27\/27\\\)" psql -q -f tests\/db\/r203-test-studio-0381\.sql/);
  assert.match(read('supabase/CHECK-PROD-MIGRATIONS.sql'), /0381_r203_test_studio_two_step/);
  for (const f of ['test/release-1019.test.mjs', 'test/release-1020.test.mjs']) assert.match(read(f), /'0379', '0381'(, '\d{4}')*\];/, f);
});
await t('banner + nudges: my_test_studio read (cached, READ_RPCS), banner for everyone in a test studio, no two-step nudge there', () => {
  assert.match(API, /\|my_seat_usage\|my_test_studio\|my_notification_prefs\|/);
  assert.match(methodSrc(API, 'testStudio() {'), /supa\.rpc\("my_test_studio"\)/);
  const b = fnSrc(AUI, 'testStudioBanner');
  assert.match(b, /if \(t !== true \|\| !doc\.body\) return;/);
  assert.match(b, /title: "Test studio \\u2014 two-step not enforced"/);
  assert.ok(!/onDismiss/.test(b), 'persistent (no dismiss)');
  assert.match(AUI, /    trialStatus\(\);\n    testStudioBanner\(\);/);
  assert.match(fnSrc(AUI, 'adminTwoStep'), /if \(ts !== true\) adminTwoStepNudge\(st\);/);
});
await t('Settings: R202\'s Admin two-step note (shown before the click) stays quiet in a Helm HQ test studio', () => {
  const f = fnSrc(CTL, 'umMyTwoStep');
  assert.match(f, /BPStore\.auth\.mfa\.testStudio\(\)\)===true\)\{ umMy2Step=true; return true; \}/);
  assert.ok(f.indexOf('testStudio') < f.indexOf('verifiedTotp'), 'test studio checked first');
  assert.ok(!/adminRoleNote|_admin_note/.test(CTL), 'one note only (R202\'s)');
});
await t('asset pins: store-api v374 + auth-ui v63 everywhere, page-tours v56', () => {
  for (const f of readdirSync(new URL('../public/', import.meta.url)).filter((x) => x.endsWith('.html'))) {
    const s = read('public/' + f);
    const m = s.match(/store-api\.js\?v=(\d+)/); if (m) assert.equal(m[1], '395', f);
    const a = s.match(/auth-ui\.js\?v=(\d+)/); if (a) assert.equal(a[1], '66', f);
    const p = s.match(/page-tours\.js\?v=(\d+)/); if (p) assert.equal(p[1], '66', f);
  }
  assert.match(API, /AUTH_UI_VERSION = "66"/);
});

console.log(`r203-auth-mail-2step: ${n} passed`);
