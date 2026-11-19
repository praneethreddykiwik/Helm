// R231: errors from the production Supabase log (18-19 Nov 2026), fixed in the browser (no database change).
//  1  rpc/signin_notice_ping 401 "permission denied" right after a failed /auth/v1/verify: the 0383 fallback ping asks
//     only while the SAME signed-in session is still there (never on /auth/confirm, never with a run-out token).
//  2  rpc/runsheet_team_options 403: a run-sheet viewer (no Run sheet - Can change) is not asked for the team list.
//  3  task_templates insert 403 (row-level security): "Save to checklist" refused -> kept for this event, plain words.
//  5  accept_invitation 403 own_trial: the join page lays out the two ways forward; nothing is left / closed here.
//  6  admin_create_user_temp / create_invitation 403 R35_SETUP_2STEP: an Admin add / invite is stopped in the browser
//     while my two-step is off (note + greyed button); create_invitation now goes through withStepUp like Add user.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('  ✓ ' + name); };
const fnSrc = (src, name) => {
  const at = src.indexOf('function ' + name + '('); assert.ok(at >= 0, name + ' missing');
  let d = 0; for (let k = src.indexOf('{', src.indexOf(')', at)); k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}' && !--d) return src.slice(at, k + 1); }
  throw new Error(name + ' unterminated');
};
const API = read('public/store-api.js'), RR = read('public/runsheet-remind.js'), RS = read('public/runsheet.html');
const OPS = read('public/ops.html'), LOGIN = read('public/login.html'), CTL = read('public/control.html');
const SID = '804439b1-5769-4c23-9232-8a045851612f', UID = '11111111-2222-4333-8444-555555555555';
const tok = (o) => 'h.' + Buffer.from(JSON.stringify(o)).toString('base64url') + '.x';

/* ---- 1. the sign-in notice fallback ping ---- */
function pingHarness({ page = 'dashboard', current, signedOut = false } = {}) {
  const calls = [], timers = [], ss = {}, ls = {};
  const ctx = {
    atob: (s) => Buffer.from(s, 'base64').toString('binary'), window: {}, navigator: { userAgent: 'UA' }, Date,
    setTimeout: (f) => { timers.push(f); }, Promise,
    sessionStorage: { getItem: (k) => (k in ss ? ss[k] : null), setItem: (k, v) => { ss[k] = String(v); }, removeItem: (k) => { delete ss[k]; } },
    localStorage: { getItem: (k) => (k in ls ? ls[k] : null), setItem: (k, v) => { ls[k] = String(v); } },
    pageKey: () => page, explicitSignOut: signedOut,
    supa: { auth: { getSession: async () => ({ data: { session: current } }) },
      rpc: (fn, a) => { calls.push(fn); return Promise.resolve({ data: { via: 'ping' }, error: null }); } },
  };
  vm.runInNewContext(fnSrc(API, 'jwtSessionId') + '\n' + fnSrc(API, 'signinPing') + '\nglobalThis.ping=signinPing;', ctx);
  return { ctx, calls, timers, ss, run: async () => { for (const f of timers.splice(0)) f(); await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)); } };
}
const live = () => ({ user: { id: UID }, access_token: tok({ session_id: SID }), expires_at: Math.floor(Date.now() / 1000) + 3600 });

await t('1 ping: a live, unchanged session pings once (the R205 behaviour is kept)', async () => {
  const s = live(), h = pingHarness({ current: s });
  h.ctx.ping(s); await h.run();
  assert.deepEqual(h.calls, ['signin_notice_ping']);
  h.ctx.ping(s); await h.run(); assert.equal(h.calls.length, 1, 'once per session per tab');
});
await t('1 ping: session gone by the time the timer fires (signed out / failed link) -> no request, mark cleared', async () => {
  const s = live(), h = pingHarness({ current: null });
  h.ctx.ping(s); await h.run();
  assert.deepEqual(h.calls, []); assert.equal(h.ss['helm.r383.ping'], undefined, 'a later real sign-in can still ping');
});
await t('1 ping: a different session / user, or a run-out token -> no request', async () => {
  const s = live();
  for (const cur of [{ ...live(), access_token: tok({ session_id: '904439b1-5769-4c23-9232-8a045851612f' }) },
    { ...live(), user: { id: 'aaaaaaaa-2222-4333-8444-555555555555' } }, { ...live(), expires_at: 1 }]) {
    const h = pingHarness({ current: cur }); h.ctx.ping(s); await h.run(); assert.deepEqual(h.calls, []);
  }
  const h = pingHarness({ current: s }); h.ctx.ping({ ...s, expires_at: 1 }); await h.run();
  assert.deepEqual(h.calls, []); assert.equal(h.timers.length, 0, 'an expired token is not even scheduled');
});
await t('1 ping: never from /auth/confirm, never after an explicit sign-out', async () => {
  const s = live();
  for (const o of [{ page: 'auth-confirm' }, { signedOut: true }]) {
    const h = pingHarness({ current: s, ...o }); h.ctx.ping(s); await h.run();
    assert.deepEqual(h.calls, []); assert.equal(h.timers.length, 0);
  }
});

/* ---- 2. run-sheet team list ---- */
await t('2 run-sheet: view-only people are not asked for runsheet_team_options; editors still are', async () => {
  assert.match(RS, /await RR\.init\(BPStore,\{ canPick:canEdit \}\);/);
  const src = fnSrc(RR, 'init');
  const mk = () => { const c = []; return { c, store: { people: { options: async () => [] },
    automation: { settings: async () => ({ ok: 1 }), teamOptions: async () => { c.push('team'); return [{ id: 1 }]; } } } }; };
  const S = { ready: false, people: [], team: [], targets: {}, cfg: null };
  const ctx = { S }; vm.runInNewContext('globalThis.init = async ' + src, ctx);
  let m = mk(); await ctx.init(m.store, { canPick: false }); assert.deepEqual(m.c, []); assert.equal(S.team.length, 0); assert.equal(S.ready, true);
  m = mk(); await ctx.init(m.store, { canPick: true }); assert.deepEqual(m.c, ['team']);
  m = mk(); await ctx.init(m.store); assert.deepEqual(m.c, ['team'], 'no options = as before');
});

/* ---- 3. task templates ---- */
await t('3 Tasks & crew: a refused checklist save keeps the task for this event, says why, and stops offering the checklist', () => {
  const i = OPS.indexOf('try{ await BPStore.ops.addTemplate(cat,title); }'); assert.ok(i > 0);
  const blk = OPS.slice(i, OPS.indexOf('$("#tpl_title").value=""; await renderTasks();\n    const box', i));
  assert.match(blk, /row-level security\|42501\|permission denied/);
  assert.match(blk, /canTpl=false;/);
  assert.match(blk, /oneOff\[cat\]=oneOff\[cat\]\|\|\[\]/);
  assert.match(blk, /needs Templates - Can change \(ask your studio admin\)/);
  assert.match(OPS, /if\(!canTpl\)\{ const l=oneOff\[cat\]/, 'R208 gate still first');
});

/* ---- 5. own free-trial studio ---- */
await t('5 join page: own_trial -> heading + two choices (different e-mail / Helm support), Sign out + Go to my trial studio', () => {
  const f = fnSrc(LOGIN, 'showInviteError'); const b = f.slice(f.indexOf('own_trial'), f.indexOf('box.hidden=false; return; }') + 1);
  assert.match(b, /This e-mail already has its own free-trial studio/);
  assert.match(b, /Use a different e-mail for "\+who\+"/);
  assert.match(b, /contact Helm support to close your free-trial studio first/);
  assert.match(b, /inviteBtn\("inviteSignOut","Sign out"/); assert.match(b, /inviteBtn\("inviteMyStudio","Go to my trial studio"/);
  assert.doesNotMatch(b, /rpc\(|innerHTML/, 'words + DOM only, nothing joined / left / closed');
});

/* ---- 6. two-step before adding / inviting an Admin ---- */
await t('6 Users & invites: Admin + my two-step off -> stopped before the server, note + greyed button; other roles go on', async () => {
  const blocked = fnSrc(CTL, 'um2StepBlocked'), gate = fnSrc(CTL, 'um2StepGate');
  const mkBtn = () => { const a = {}; return { a, disabled: false, dataset: {}, title: '', setAttribute: (k, v) => { a[k] = v; }, removeAttribute: (k) => { delete a[k]; } }; };
  const els = { '#um_role': { value: 'admin' }, '#um_submit': mkBtn(), '#inv_2step': { hidden: false, scrollIntoView() {}, querySelector: () => ({ focus() {} }) } };
  let my = false, painted = 0; const msgs = [];
  const ctx = { $: (s) => els[s], UM_2STEP_ROLES: ['admin'], get umMy2Step() { return my; }, umMyTwoStep: async () => my,
    um2StepPaintAll: () => { painted++; }, setUMsg: (k, m) => msgs.push(k) };
  vm.runInNewContext('async ' + blocked + '\n' + gate + '\nglobalThis.b=um2StepBlocked; globalThis.g=um2StepGate;', ctx);
  assert.equal(await ctx.b('admin', 'inv'), true); assert.equal(painted, 1);
  assert.equal(await ctx.b('manager', 'inv'), false, 'only an Admin needs two-step (0285)');
  my = true; assert.equal(await ctx.b('admin', 'inv'), false);
  my = null; assert.equal(await ctx.b('admin', 'inv'), false, 'unknown -> the server decides (never blocks on a guess)');
  my = false; ctx.g('#um_role', '#um_submit'); assert.equal(els['#um_submit'].a['aria-disabled'], 'true');
  my = true; ctx.g('#um_role', '#um_submit'); assert.equal(els['#um_submit'].a['aria-disabled'], undefined);
  assert.equal(els['#um_submit'].disabled, false, 'the seat counter keeps owning .disabled');
  assert.match(CTL, /if\(await um2StepBlocked\(role,"um"\)\) return;/);
  assert.match(fnSrc(CTL, 'sendInvite'), /^function sendInvite\(email, role, btn, T\)\{\n    if\(await um2StepBlocked\(role,"inv"\)\) return false;/);
  assert.match(API, /: withStepUp\(\(\) => rpc\("create_invitation", \{ p_email: email, p_role: role \}\)\)\),/);
});

/* ---- 4. studio_test_mode: no live code path without 0381 ---- */
await t('4 studio_test_mode: only 0381 objects read it, all created after the table in the same file', () => {
  const M = read('supabase/migrations/0381_r203_test_studio_two_step.sql').replace(/^--.*$/gm, '');
  const tbl = M.indexOf('create table if not exists public.studio_test_mode (');
  assert.ok(tbl > 0);
  for (const f of ['public._r381_two_step_exempt', 'public.hq_set_test_studio', 'public._r381_tg_test_mode_log']) assert.ok(M.indexOf('function ' + f) > tbl, f);
  assert.doesNotMatch(M, /drop table[^;]*studio_test_mode/i);
});

console.log(`r231-prod-log-errors: ${n} passed`);
