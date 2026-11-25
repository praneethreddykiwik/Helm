// r199-team-invites.test.mjs - R199 (owner 17 Nov 2026): Settings -> Users & invites + Staff Directory made clear, and page
// banners float as toasts app-wide.
//   1. team-status.js: account status words (Invited - not signed up yet / expired, Signed up - never signed in, Last signed in
//      <relative>, Deactivated), the separate profile hint, the Show filter.
//   2. control.html: the members table (Account column, invite rows, View on every row, full e-mails), the add-user refusal
//      under the form + "Send invite link instead", one invite path, Resend / Copy / Cancel invite, sticky errors.
//   3. store-api.js: accountStatus() -> team_account_status (0378), the banner -> toast observer (pure spec + wiring).
//   4. staff.html: pills, Cancel invite, record-only default, "Reactivate the existing record" (question 6).
//   5. flow-resume.js waits for window.HelmPageQuote (no mark_flow_step / progress read for a quote the page did not find).
//   6. 0378 files: migration, APPLY paste file, MANIFEST, checker override, run-all, release lists, asset pins.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ROOT = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');
let n = 0;
const t = async (name, fn) => { try { await fn(); n++; console.log('  ok ' + name); } catch (e) { console.error('  FAIL ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; } };
const fnSrc = (src, name) => {
  const at = src.indexOf('function ' + name + '('); assert.ok(at >= 0, name + ' missing');
  let d = 0; for (let k = src.indexOf('{', src.indexOf(')', at)); k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}' && !--d) return src.slice(at, k + 1); }
  throw new Error(name + ' unterminated');
};
const CTL = read('public/control.html'), STAFF = read('public/staff.html'), API = read('public/store-api.js'), TSJS = read('public/team-status.js');
const FR = read('public/flow-resume.js'), CSS = read('public/team-status.css');
const TS = require('../public/team-status.js');
const NOW = Date.parse('2026-11-17T10:00:00Z'), H = 3600e3, D = 24 * H;
const iso = (ms) => new Date(ms).toISOString();

/* ---------------------------------------------------------------- 1. team-status.js */
await t('member status: last signed in (relative), never signed in, temporary password, no password yet, deactivated, old database', () => {
  const u = { user_id: 'u1', full_name: 'Spandana', phone: '+919876543210', complete: true, created_at: iso(NOW - 10 * D) };
  const act = TS.member(u, { last_sign_in_at: iso(NOW - 3 * D), joined_at: iso(NOW - 10 * D) }, NOW);
  assert.equal(act.key, 'active'); assert.equal(act.label, 'Last signed in 3 days ago'); assert.match(act.detail, /^Joined /);
  assert.equal(TS.member(u, { last_sign_in_at: iso(NOW - 5 * 60e3) }, NOW).label, 'Last signed in 5 min ago');
  assert.equal(TS.member(u, { last_sign_in_at: iso(NOW - 2 * H) }, NOW).label, 'Last signed in 2 hours ago');
  assert.equal(TS.member(u, { last_sign_in_at: iso(NOW - 30 * H) }, NOW).label, 'Last signed in yesterday');
  const never = TS.member(u, { last_sign_in_at: null, joined_at: iso(NOW - D) }, NOW);
  assert.equal(never.key, 'never'); assert.equal(never.label, 'Signed up – never signed in');
  const temp = TS.member(u, { last_sign_in_at: null, temp_password: true }, NOW);
  assert.equal(temp.label, 'Added by admin – hasn’t signed in yet'); assert.match(temp.detail, /Temporary password unused/);   // R202 wording
  assert.equal(TS.member(u, { last_sign_in_at: null, needs_password: true }, NOW).key, 'setup');
  const off = TS.member(u, { deactivated: true, deactivated_at: iso(NOW - D), last_sign_in_at: iso(NOW - 2 * D) }, NOW);
  assert.equal(off.key, 'off'); assert.equal(off.label, 'Deactivated'); assert.match(off.detail, /^Since .*records kept/);
  assert.equal(TS.member(Object.assign({}, u, { deactivated: true }), null, NOW).label, 'Deactivated');
  const old = TS.member(u, null, NOW); assert.equal(old.key, 'unknown'); assert.equal(old.label, 'Member'); assert.match(old.detail, /^Joined /);
  for (const s of [act, never, temp, off, old]) assert.doesNotMatch(s.label, /Complete|Incomplete/, 'never the old "Complete" word');
});
await t('invite status: Invited - not signed up yet (sent, link expires date + time + in N days) / expired', () => {
  const inv = { email: 'a@b.test', role: 'manager', created_at: iso(NOW - H), expires_at: iso(NOW + 7 * D - H), emailed_at: iso(NOW - 50 * 60e3) };
  const s = TS.invite(inv, NOW);
  assert.equal(s.key, 'invited'); assert.equal(s.label, 'Invited – not signed up yet');
  assert.match(s.detail, /^Sent .* · link expires .*\(in 6 days\)$/); assert.match(s.title, /Invitation e-mail sent/);
  const e = TS.invite(Object.assign({}, inv, { expires_at: iso(NOW - D) }), NOW);
  assert.equal(e.key, 'expired'); assert.equal(e.label, 'Invite expired – not signed up'); assert.match(e.detail, /link expired /); assert.match(e.title, /Resend invite/);
  assert.equal(TS.invite(Object.assign({}, inv, { expired: true }), NOW).key, 'expired', 'the server flag wins');
  assert.equal(TS.until(iso(NOW + 5 * H), NOW), 'in 5 hours'); assert.equal(TS.until(iso(NOW - H), NOW), '');
});
await t('profile hint is separate and specific; the Show filter', () => {
  assert.equal(TS.profileHint({ complete: true }, true), '');
  assert.equal(TS.profileHint({ complete: false, full_name: 'Ravi', phone: '' }, true), 'Profile: mobile number missing');
  assert.equal(TS.profileHint({ complete: false, full_name: '', phone: '' }, true), 'Profile: name and mobile number missing');
  assert.equal(TS.profileHint({ complete: false, full_name: 'Ravi' }, false), 'Profile incomplete', 'no phone column -> no guess about the phone');
  const M = (k) => ({ key: k });
  assert.ok(TS.matches(M('invited'), 'invited') && TS.matches(M('expired'), 'invited') && !TS.matches(M('active'), 'invited'));
  assert.ok(TS.matches(M('never'), 'never') && TS.matches(M('setup'), 'never') && !TS.matches(M('off'), 'never'));
  assert.ok(TS.matches(M('off'), 'off') && TS.matches(M('active'), 'active') && TS.matches(M('x'), ''));
  assert.ok(!TS.matches(M('invited'), 'incomplete', { __invite: true, complete: false }));
});
await t('team-status.js: the drawer is built with textContent only; copy buttons; Escape / backdrop / Close', () => {
  const code = TSJS.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.doesNotMatch(code, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.match(TSJS, /setAttribute\("role", "dialog"\); drawer\.setAttribute\("aria-modal", "true"\)/);
  assert.match(TSJS, /if \(e\.key === "Escape"\) \{ e\.stopPropagation\(\); closeDrawer\(\); \}/);
  assert.match(TSJS, /if \(opt\.copy\) \{ var b = mk\("button", "btn sm tsd-copy", "Copy"\)/);
  assert.match(CSS, /\.tsd-val\{overflow-wrap:anywhere;word-break:break-word;min-width:0;user-select:text\}/, 'the full e-mail wraps, never cut off');
  assert.match(CSS, /\.tsd-modal,html\[data-shell\] \.lmodal\.tsd-modal\{padding:0;align-items:flex-end;/, 'a bottom sheet on a phone, over the shell centred-card rule');
  assert.match(CSS, /html\[data-shell\] \.lmodal\.tsd-modal>\.tsd-sheet\{width:100%;max-width:100%;margin:0;/);
});

/* ---------------------------------------------------------------- 2. control.html */
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function ucTable() {
  const ctx = { esc, HelmTeamStatus: TS };
  vm.runInNewContext('const ucId=(u)=>u.user_id||u.id;' + ['ucDate', 'ucShownName', 'ucNameHtml', 'ucPhone', 'ucInitials', 'ucPrivateVisible', 'ucMatches', 'ucState', 'ucAcctCell', 'ucInviteRows', 'ucTable']
    .map((f) => fnSrc(CTL, f)).join('\n') + '\nglobalThis.T=ucTable;', ctx);
  return ctx.T;
}
const ROW = (i, o) => Object.assign({ id: 'u' + i, email: 'person' + i + '@studio.test', full_name: 'Person ' + i, role: 'crew', phone: '+919876543210',
  job_title: 'Rigger', department: 'Production', complete: true, created_at: '2026-09-01', whatsapp_same: true }, o || {});
const ACCT = { byId: { u1: { user_id: 'u1', last_sign_in_at: iso(NOW - 3 * D) }, u2: { user_id: 'u2', last_sign_in_at: null, joined_at: iso(NOW - D) } },
  invites: [{ id: 'i1', email: 'new.person@very-long-studio-domain.test', role: 'manager', created_at: iso(NOW - H), expires_at: iso(NOW + 6 * D), invited_by_name: 'Asha' },
    { id: 'i2', email: 'old@studio.test', role: 'crew', created_at: iso(NOW - 9 * D), expires_at: iso(NOW - 2 * D), expired: true },
    { id: 'i3', email: 'person2@studio.test', role: 'crew', created_at: iso(NOW - H), expires_at: iso(NOW + D) }] };
await t('members table: "Account" column (not Profile / Complete), status + separate profile hint, View on every row', () => {
  const T = ucTable();
  const r = T([ROW(1, { role: 'admin' }), ROW(2, { complete: false, phone: '' })], { profiles: true, meId: 'u1', roles: ['admin', 'crew'], roleLabel: (x) => x, canEdit: true, q: '', filter: '', acct: ACCT, now: NOW });
  assert.match(r.head, /<th scope="col">Status<\/th><th scope="col">Two-step<\/th>/); assert.doesNotMatch(r.head + r.body, /Profile<\/th>|✓ Complete|✗ Incomplete/);
  assert.match(r.body, /<td class="ucprof" data-label="Status"><span class="ucst ucst-ok" title="Last sign-in: [^"]+">Last signed in 3 days ago<\/span><\/td>/);   // R228: no "Joined" line on a signed-in row (it is in View)
  assert.match(r.body, /<span class="ucst ucst-warn"[^>]*>Signed up – never signed in<\/span>/);
  assert.match(r.body, /<div class="ucsub ucst-hint"[^>]*>Profile: mobile number missing<\/div>/);
  assert.equal((r.body.match(/class="btn sm ucView"/g) || []).length, 4, 'View on both members + both open invites (the invite of a member is not repeated)');
  assert.match(r.body, /<td class="ucact"><button type="button" class="btn sm ucView" aria-label="View details of Person 1">View<\/button><button type="button" class="btn sm ucEdit"/);
  assert.equal(r.members, 2); assert.equal(r.invited, 2); assert.equal(r.total, 4);
});
await t('members table: open + expired invites are rows (Resend invite / Cancel invite / View), the full address shown, escaped', () => {
  const T = ucTable();
  const evil = { byId: {}, invites: [{ id: 'x"><img src=x>', email: '"><img src=x onerror=alert(1)>@x.test', role: '<b>r</b>', created_at: iso(NOW), expires_at: iso(NOW + D) }] };
  const r = T([ROW(1)], { profiles: true, meId: 'u1', roles: ['crew'], roleLabel: (x) => x, canEdit: true, q: '', filter: '', acct: ACCT, now: NOW });
  assert.match(r.body, /<tr class="ucr ucinv" data-inv="i1" data-email="new\.person@very-long-studio-domain\.test" data-role="manager">/);
  assert.match(r.body, /<span class="dnTxt em ucinv-em">new\.person@very-long-studio-domain\.test<\/span><\/div><div class="ucsub">Invited by Asha<\/div>/);
  assert.match(r.body, /data-inv="i1"[\s\S]*?Invited – not signed up yet[\s\S]*?link expires/);
  assert.match(r.body, /data-inv="i2"[\s\S]*?<span class="ucst ucst-off"[^>]*>Invite expired – not signed up<\/span>/);
  // R228: the one main step sits under the status; Cancel invite (and Copy link) are items of the row's "..." menu
  assert.match(r.body, /<div class="ucnext"><button type="button" class="btn sm primary ucInvResend" title="The link expired - this sends a new link that works 7 days" aria-label="Resend invite to old@studio\.test">Resend invite \(new link\)<\/button><\/div><\/td>/);
  assert.match(r.body, /<button type="button" class="btn sm ucView" aria-label="View invite for old@studio\.test">View<\/button><div class="ucmw"><button type="button" class="btn sm ucMore" aria-haspopup="menu" aria-expanded="false" aria-controls="ucmn-\d+" aria-label="More actions for old@studio\.test"[^>]*>[\s\S]*?<div class="ucmenu" id="ucmn-\d+" role="menu" aria-label="More actions for old@studio\.test" hidden><button type="button" role="menuitem" tabindex="-1" class="ucmi ucInvCancel" aria-label="Cancel invite for old@studio\.test">Cancel invite<\/button><\/div>/);
  const e = T([], { profiles: true, meId: 'u1', roles: [], q: '', filter: '', acct: evil, now: NOW, canEdit: true });
  assert.doesNotMatch(e.body, /<img|<b>r/); assert.match(e.body, /&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;@x\.test/);
  const noEdit = T([ROW(1)], { profiles: true, meId: 'u9', roles: ['crew'], q: '', filter: '', acct: ACCT, now: NOW });
  assert.doesNotMatch(noEdit.body, /ucInvResend|ucInvCancel|ucEdit/, 'no invite actions without edit rights');
});
await t('members table: the Show filter (Invited / Never signed in / Signed in / Deactivated / Incomplete) + search', () => {
  const T = ucTable(), o = (f, q) => ({ profiles: true, meId: 'u1', roles: ['crew'], q: q || '', filter: f, acct: ACCT, now: NOW, canEdit: true });
  const rows = [ROW(1), ROW(2, { complete: false })];
  assert.equal(T(rows, o('invited')).shown, 2); assert.equal(T(rows, o('never')).shown, 1); assert.equal(T(rows, o('active')).shown, 1);
  assert.equal(T(rows, o('off')).shown, 0); assert.equal(T(rows, o('incomplete')).shown, 1); assert.equal(T(rows, o('')).shown, 4);
  assert.equal(T(rows, o('', 'very-long')).shown, 1, 'search finds an invited e-mail');
  // without 0378 (acct null): no invite rows, status "Member" + Joined, nothing breaks
  const old = T(rows, { profiles: true, meId: 'u1', roles: ['crew'], q: '', filter: '', canEdit: true });
  assert.equal(old.total, 2); assert.match(old.body, /<span class="ucst ucst-muted"[^>]*>Member<\/span><div class="ucsub ucst-d">Joined /);
  assert.match(CTL, /<option value="invited">Invited – not signed up<\/option><option value="never">Never signed in<\/option><option value="active">Signed in<\/option><option value="off">Deactivated<\/option><option value="incomplete">Incomplete profiles<\/option>/);
});
await t('members table: renderUsers asks team_account_status alongside the list (never blocks it); counts "N members · N invited"', () => {
  assert.match(CTL, /const acP=isAdmin&&BPStore\.auth\.admin\.accountStatus\?BPStore\.auth\.admin\.accountStatus\(\)\.catch\(\(\)=>null\):Promise\.resolve\(null\);/);
  assert.match(CTL, /team, acct:ucAcct, now:Date\.now\(\)\}\);/);
  assert.match(CTL, /\(invd\?" · "\+invd\+" invited":""\)/);
  assert.match(CTL, /tb\.querySelectorAll\("\.ucView"\)[\s\S]{0,200}viewInvite\(i\); \} else \{ const u=rowOf\(tr\); if\(u\) viewMember\(u, team\); \}/);
});
await t('View drawer: full e-mail + phone with Copy, role, title, status, last sign-in, joined, invited by; invite drawer actions', () => {
  const vm1 = fnSrc(CTL, 'viewMember'), vi = fnSrc(CTL, 'viewInvite');
  for (const k of ['"E-mail", u.email||u.email_name||"", { copy:!!u.email, mono:true }', '"Phone", u.phone?ucPhone(u.phone):"", { copy:!!u.phone', '"Job title"', '"Account status"', '"Last signed in"', '"Joined"', '"Invited by"', '"Two-step"', '"Profile"'])
    assert.ok(vm1.includes(k), k);
  for (const k of ['"E-mail", inv.email, { copy:true, mono:true }', '"Invite sent"', '"Link expired":"Link expires"', '"Invitation e-mail"', 'Resend invite (new link)', '"Copy invite link", disabled:exp', '"Cancel invite", danger:true'])
    assert.ok(vi.includes(k), k);
});
await t('add user refused (address already has a Helm account): message UNDER the form + one-click "Send invite link instead" + sticky toast', () => {
  assert.match(CTL, /<div class="um-err" id="um_err" role="alert" data-no-toast hidden><p class="um-err-t" id="um_err_t"><\/p><div class="um-err-acts" id="um_err_acts"><\/div><\/div>/);
  const sub = CTL.slice(CTL.indexOf('$("#um_add").addEventListener("submit"'), CTL.indexOf('// ---- invite by email link (Phase 83) ----'));
  assert.match(sub, /if\(\/send them an invitation instead\/i\.test\(m\)\)\{/);
  assert.match(sub, /This e-mail already has a Helm account \(maybe in another studio\), so it can't be added with a temporary password\. Send them an invitation link instead/);
  assert.match(sub, /umErrShow\(txt, offer\);/);
  assert.match(sub, /BPUI\.toast\(txt,\{ type:"err", title:"Couldn't add "\+email, timeout:0, place:"top", action:\{ label:"Send invite link instead", onClick:\(\)=>\{ umErrHide\(\); sendInvite\(email, role,/);
  assert.match(fnSrc(CTL, 'umErrShow'), /b\.textContent="Send invite link instead";\s*b\.addEventListener\("click",\(\)=>\{ umErrHide\(\); sendInvite\(offer\.email, offer\.role, b\); \}\)/);
  assert.match(sub, /<div class="msg ok" data-no-toast style="line-height:1\.6">Added <b>/, 'the temporary password never goes into a toast');
  assert.match(CTL, /function addUserErr\(err\)/, 'the other refusals keep their words');
});
await t('one invite path (form, Send invite link instead, expired Resend); Resend / Copy / Cancel invite; errors stay put', () => {
  const si = fnSrc(CTL, 'sendInvite');
  assert.match(si, /BPStore\.invitations\.create\(email, role\)/); assert.match(si, /setUMsg\(\.\.\.inviteMailMsg\(sent,email\)\)/);
  assert.match(CTL, /await sendInvite\(email, role, \$\("#inv_submit"\), T\|\|\{\}\);/);
  const rs = fnSrc(CTL, 'invResend');
  assert.match(rs, /if\(invExpired\(inv\)\)\{[\s\S]*Send a new link\? It works for 7 days[\s\S]*await sendInvite\(email, inv\.role, btn\); return;/);
  assert.match(rs, /BPStore\.invitations\.resendEmail\(inv\.id\)/); assert.match(rs, /Already sent recently — you can resend in/);
  const cp = fnSrc(CTL, 'invCopy'); assert.match(cp, /has expired — use Resend invite/); assert.match(cp, /BPStore\.invitations\.create\(inv\.email, inv\.role\)/);
  const cc = fnSrc(CTL, 'invCancel');
  assert.match(cc, /Cancel the invite for \$\{email\}\? Their link stops working at once\. Nothing else changes — no account or staff record is deleted/);
  assert.match(cc, /BPStore\.invitations\.revoke\(inv\.id\)/); assert.doesNotMatch(cc.replace(/is deleted/g, ''), /delete/i, 'cancel never deletes');
  const ri = fnSrc(CTL, 'renderInvites');
  assert.match(ri, /<button type="button" class="btn invResend">Resend invite<\/button> <button type="button" class="btn invRevoke">Cancel invite<\/button>/);
  assert.match(ri, /\$\{exp\?' disabled title="The link expired - use Resend invite"':""\}>Copy link<\/button>/);
  assert.match(fnSrc(CTL, 'setUMsg'), /if\(t&&k!=="err"\) uMsgT=setTimeout/, 'an error banner no longer vanishes after 4 seconds');
  assert.doesNotMatch(CTL, /revoke a pending invite or remove someone/);
});

/* ---------------------------------------------------------------- 3. store-api.js */
await t('store-api: accountStatus() -> team_account_status; null on an older database / not allowed', () => {
  assert.match(API, /async accountStatus\(\) \{\s*if \(!supa\) return null;\s*const \{ data, error \} = await supa\.rpc\("team_account_status"\);\s*if \(error\) \{ if \(rpcMissing\(error\) \|\| error\.code === "42501"\) return null; throw error; \}/);
});
const spec = (() => { const c = {}; vm.runInNewContext(fnSrc(API, 'bannerToastSpec') + '\nglobalThis.S=bannerToastSpec;', c); return c.S; })();
await t('banner -> toast: shared banners float (errors sticky, ok 5 s), field / modal / opted-out / hidden never; other alerts only off screen', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(spec({ cls: 'msg err', text: "  Couldn't add the user.\n This e-mail ...  ", onScreen: true }))), { text: "Couldn't add the user. This e-mail ...", type: 'err', timeout: 0 });
  assert.equal(spec({ cls: 'msg ok', text: 'Role updated.' }).timeout, 5000);
  assert.equal(spec({ cls: 'msg warn', text: 'Careful now' }).type, 'warn');
  assert.equal(spec({ cls: 'alert err', text: 'Payment failed' }).type, 'err');
  assert.equal(spec({ cls: 'errbar', text: 'Could not load' }).type, 'err');
  assert.equal(spec({ cls: 'msg err', text: 'x', inModal: true }), null);
  assert.equal(spec({ cls: 'msg err', text: 'Bad thing', hidden: true }), null);
  assert.equal(spec({ cls: 'msg err', text: 'Bad thing', optOut: true }), null);
  assert.equal(spec({ cls: 'ferr', text: 'Name is required', alertRole: true, onScreen: false }), null, 'field errors stay by the field');
  assert.equal(spec({ cls: 'err', text: 'Sign-in failed', alertRole: true, onScreen: true }), null, 'a visible alert is not repeated');
  assert.equal(spec({ cls: 'err', text: 'Sign-in failed', alertRole: true, onScreen: false }).type, 'err', 'an alert scrolled away floats');
  assert.equal(spec({ cls: 'note', text: 'Plain text' }), null);
  assert.ok(spec({ cls: 'msg info', text: 'y'.repeat(500) }).text.length <= 300);
});
await t('banner -> toast wiring: one observer, baseline (no toast for banners already there), quiet lane, top-right stack on wide screens', () => {
  assert.match(API, /var BANNER_SEL = "\.msg\.err, \.msg\.ok, \.msg\.warn, \.msg\.info, \.alert\.err, \.errbar";/);
  assert.match(API, /var hnd = toast\(spec\.text, \{ type: spec\.type, timeout: spec\.timeout, place: "top", quiet: true \}\);/);
  assert.match(API, /if \(k && bannerOpen\[k\]\) \{ try \{ bannerOpen\[k\]\.close\(\); \} catch \(e\) \{\} \}/, 'a new message in the same place replaces the old card');
  assert.match(API, /\/\/ banners already in the page when it loads are its normal content \(not news\): remembered, never popped/);
  assert.match(API, /observe\(doc\.body, \{ childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: \["hidden", "class"\] \}\)/);
  assert.match(API, /whenBody\(watchBanners\);/);
  assert.match(API, /lanes\.quiet = h\("div", \{ class: "bpui-lane" \}\);/); assert.match(API, /topLanes\.quiet = h\("div", \{ class: "bpui-lane" \}\);/);
  assert.match(API, /var lane = o\.quiet \? L\.quiet : \(type === "err" \|\| type === "sec"\) \? L\.assertive : L\.polite;/);
  assert.match(API, /"@media \(min-width:641px\)\{\.bpui-toasts\.bpui-toasts-top\{top:72px;bottom:auto\}\}"/);
  assert.match(API, /if \(global\.matchMedia && global\.matchMedia\("\(max-width:640px\)"\)\.matches\) return "main";/, 'phones: the one bottom stack');
  assert.match(API, /doc\.querySelectorAll\("\.bpui-toasts \.bpui-toast"\)/, 'the same message is one card across both stacks');
  assert.match(API, /floatBanner: mirrorBanner,/);
  assert.match(API, /if \(place === "top"\) \{ try \{ topRoot\.style\.top = Math\.max\(16, Math\.round\(headerBottom\(\)\) \+ 12\) \+ "px";/, 'measured: always under the app header');
  assert.match(fnSrc(API, 'headerBottom'), /doc\.querySelectorAll\("\.hb-header, header"\)/);
  assert.match(API, /if \(node\.closest && node\.closest\("\.bpui-toasts"\)\) return;/, 'a toast never copies itself');
});

/* ---------------------------------------------------------------- 4. staff.html */
await t('Staff Directory: clear pills (No login / Invited – not signed up / Invite expired / Linked account) + Cancel invite', () => {
  assert.match(STAFF, />Invited – not signed up<\/span>/); assert.match(STAFF, />Invite expired · No login<\/span>/);
  assert.match(STAFF, /title="A record only: no Helm sign-in\. They get their work through their task link\.">No login<\/span>/);
  assert.match(STAFF, />🔗 Linked account<\/span>/);
  assert.match(STAFF, /data-act="uninvite" title="Stop the invite link - [\s\S]{0,120}stays here as a record only \(task link still works\)">Cancel invite<\/button>/);
  assert.match(STAFF, /else if\(b\.dataset\.act==="uninvite"\) cancelInvite\(s,b\);/);
  const ci = fnSrc(STAFF, 'cancelInvite');
  assert.match(ci, /BPStore\.invitations\.revoke\(inv\.id\)/); assert.match(ci, /stays in the Staff Directory as a record only[\s\S]*Nothing is deleted\./);
  assert.doesNotMatch(ci, /staff\.(remove|delete)|deleteUser/);
});
await t('Add staff: "Save as a record only" is the default (checked + reset on every open); "Save and invite" is secondary', () => {
  assert.match(STAFF, /<input type="radio" name="s_access" value="record" checked><span class="acc-txt"><b class="acc-t">Save as a record only<\/b><span class="acc-d">No login \(the usual choice\)/);
  assert.match(STAFF, /<input type="radio" name="s_access" value="invite"><span class="acc-txt"><b class="acc-t">Save and invite to sign in<\/b><span class="acc-d">Only for people who will use Helm themselves/);
  assert.match(STAFF, /const rec0=document\.querySelector\('input\[name="s_access"\]\[value="record"\]'\); if\(rec0\) rec0\.checked=true;/);
  assert.match(CSS, /#s_access \.acc-card:has\(input\[value="invite"\]\) \.acc-t::after\{content:" \(only if they use Helm\)"/);
});
await t('question 6: re-adding a DEACTIVATED record with the same phone / e-mail offers "Reactivate" (never a silent second record)', () => {
  const tw = fnSrc(STAFF, 'inactiveTwin');
  assert.match(tw, /BPStore\.staff\.page\(\{ includeInactive:true, search:q, limit:200 \}\)/); assert.doesNotMatch(tw, /staff\.list\(/); assert.match(tw, /if\(r\.active!==false \|\| \(BPStore\.staff\.isDemo&&BPStore\.staff\.isDemo\(r\)\)\) continue;/);
  assert.match(tw, /BPStore\.staff\.normPhone\(r\.phone\)===ph\) return \{ row:r, why:"phone number" \}/); assert.match(tw, /return \{ row:r, why:"e-mail" \}/);
  const sv = fnSrc(STAFF, 'saveStaff');
  assert.match(sv, /if\(!linked && !editingId\)\{\s*const twin=await inactiveTwin\(rec\);/);
  assert.match(sv, /okLabel:"Reactivate "\+twin\.row\.name,cancelLabel:"Back to the form"/);
  assert.match(sv, /await BPStore\.staff\.setActive\(twin\.row\.id,true\)/);
  assert.match(sv, /already has this \$\{twin\.why\}\. Reactivate that record \(tick “Show inactive”\), or use a different/);
  assert.ok(sv.indexOf('inactiveTwin(rec)') < sv.indexOf('dupCheck('), 'asked before the name duplicate check');
});

/* ---------------------------------------------------------------- 5. flow-resume.js */
await t('flow-resume: with window.HelmPageQuote = not found, nothing is sent for that quote (mark / progress read / dismiss); found -> as before', async () => {
  const H = require('../public/flow-resume.js'), Q = '7d3c1e7a-1111-4222-8333-444455556666';
  const calls = [];
  const store = { flowProgress: { available: () => true, mark: async (q, s) => { calls.push('mark ' + s); return { ok: true }; }, list: async () => { calls.push('list'); return { rows: [] }; },
    open: async () => { calls.push('open'); return { rows: [] }; }, dismiss: async () => { calls.push('dismiss'); return { ok: true }; } } };
  globalThis.HelmPageQuote = Promise.resolve(null);
  const tr = H.track({ quoteId: Q, uid: 'u', canEdit: true, store, delay: 0 });
  await tr.land('client'); await H.resumeStep(store, 'u', Q, 500); await H.dismiss(store, 'u', Q);
  assert.deepEqual(calls, [], 'not found: no call at all');
  globalThis.HelmPageQuote = Promise.resolve(Q.toUpperCase());
  const tr2 = H.track({ quoteId: Q, uid: 'u', canEdit: true, store, delay: 0 });
  await tr2.land('venue'); await H.resumeStep(store, 'u', Q, 500); await H.dismiss(store, 'u', Q);
  assert.deepEqual(calls, ['mark venue', 'list', 'dismiss']);
  delete globalThis.HelmPageQuote;
  assert.match(FR, /function pageQuoteOk\(id\) \{\s*var p = root\.HelmPageQuote; if \(!p \|\| typeof p\.then !== "function"\) return Promise\.resolve\(true\);/);
  assert.match(FR, /withTimeout\(pageQuoteOk\(id\)\.then\(function \(ok\) \{ return ok \? get\.call\(fp, \{ scope: "studio", quote: id, limit: 1 \}\) : null; \}\), 8000, null\)/, 'the banner read waits too');
});

/* ---------------------------------------------------------------- 6. 0378 + release files + pins */
const MIG = read('supabase/migrations/0378_r199_team_account_status.sql'), APPLY = read('supabase/APPLY-0378.sql');
await t('0378: one read-only definer call, admin / Users edit, own studio, no secrets, nothing deleted; ASCII', () => {
  assert.match(MIG, /create or replace function public\.team_account_status\(\)\s*returns jsonb language plpgsql stable security definer set search_path = '' as \$\$\s*-- r199-0378/);
  assert.match(MIG, /if not \(coalesce\(public\.is_admin\(\), false\) or coalesce\(public\.has_area\('users', 'edit'\), false\)\) then\s*raise exception 'not authorized' using errcode = '42501';/);
  assert.match(MIG, /where p\.org_id = v_org;/); assert.match(MIG, /where i\.org_id = v_org and i\.status = 'pending'/);
  assert.doesNotMatch(MIG.replace(/--.*$/gm, ''), /\b(drop|delete|truncate|update|insert)\b\s/i);
  assert.doesNotMatch(MIG.replace(/--.*$/gm, ''), /'token'|'encrypted_password'|mail_key_hash/);
  assert.doesNotMatch(MIG, /[^\x00-\x7F]/, 'ASCII only'); assert.doesNotMatch(APPLY, /[^\x00-\x7F]/, 'ASCII only');
  assert.match(MIG, /grant execute on function public\.team_account_status\(\) to authenticated/);
  assert.match(MIG, /revoke all on function public\.team_account_status\(\) from anon/);
});
await t('APPLY-0378: begin; the migration; checks with select item, ok from (values ...); commit - no temp tables / session state', () => {
  assert.ok(APPLY.includes(MIG.trim()), 'carries the migration body exactly');
  assert.match(APPLY, /^-- APPLY-0378[^\n]*\n(--[^\n]*\n)*begin;\n/);
  assert.match(APPLY, /\nselect item, ok from \(values\n[\s\S]*\) v\(item, ok\) order by item;\ncommit;\n$/);
  assert.doesNotMatch(APPLY, /temp table|set local|set_config|\\set|\\ir/i);
});
await t('MANIFEST, checker override, run-all, release lists, CHECK-PROD carries 0378', () => {
  assert.ok(read('supabase/migrations/MANIFEST').includes('forward  supabase/migrations/0378_r199_team_account_status.sql'));
  assert.match(read('supabase/check-prod-overrides.json'), /"0378": \{ "note": "Users & invites account status[^\n]*"marker public\.team_account_status\(\) r199-0378", "execute authenticated public\.team_account_status\(\)"\] \}/);
  assert.match(read('scripts/db-test/run-all.sh'), /run "r199-team-status-0378" "R199-TEAM-STATUS-0378: ALL PASS \\\(21\/21\\\)" psql -q -f tests\/db\/r199-team-status-0378\.sql/);
  for (const f of ['test/release-1019.test.mjs', 'test/release-1020.test.mjs']) assert.match(read(f), /'0377', '0378'[,\]]/, f);
  assert.match(read('supabase/CHECK-PROD-MIGRATIONS.sql'), /0378_r199_team_account_status/);
  assert.match(read('tests/db/r199-team-status-0378.sql'), /now\(\) \+ interval '7 days'/, 'dates relative to now');
});
await t('asset pins: store-api v371 (R205) on every page, team-status.js / .css v1 on Settings + Staff, flow-resume bumped', () => {
  for (const f of readdirSync(new URL('../public/', import.meta.url)).filter((x) => x.endsWith('.html'))) {
    const m = read('public/' + f).match(/store-api\.js\?v=(\d+)/); if (m) assert.ok(Number(m[1]) >= 370, f);   // R204: later rounds bump it again
  }
  for (const f of ['public/control.html', 'public/staff.html']) { assert.match(read(f), /<script src="team-status\.js\?v=\d+"><\/script>/, f); assert.match(read(f), /<link rel="stylesheet" href="team-status\.css\?v=\d+">/, f); }
  assert.match(read('public/flow.html'), /flow-resume\.js\?v=12/);
});

console.log(`r199-team-invites: ${n} passed`);
