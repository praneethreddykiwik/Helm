// r202-signin-link.test.mjs - R202 (owner 18 Nov 2026, Settings -> Users & invites):
//   1. team-status.js: plainer words for an "Add user" login ("Added by admin - hasn't signed in yet" + "Temporary password
//      unused"), "sign-in link sent ..." in the detail, signInHelp() (row button / View panel / New temporary password /
//      deactivated = "Reactivate first").
//   2. control.html: Send sign-in link on the row + in View, New temporary password (admins, shown once, DOM only),
//      Reactivate redraws the row (Send sign-in link right away), the "Which should I use?" box, "Add user (create login
//      now)", the up-front two-step note for Admin (Add user AND invite), the table without sideways scroll (one who-cell).
//   3. store-api.js: sendSignInLink (0379 check -> the Supabase reset e-mail; a failed send lifts the wait), newTempPassword
//      (two-step step-up like Add user), a reset-link password change lifts "must change password".
//   4. 0379 + paste file + MANIFEST + checker + run-all + release lists + pins.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ROOT = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');
let n = 0;
const t = async (name, fn) => { try { await fn(); n++; console.log('  ok ' + name); } catch (e) { console.error('  FAIL ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; } };
const fnSrc = (src, name) => {
  const at = src.search(new RegExp('(async )?function ' + name + '\\(|async ' + name + '\\(')); assert.ok(at >= 0, name + ' missing');
  let d = 0; for (let k = src.indexOf('{', src.indexOf(')', at)); k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}' && !--d) return src.slice(at, k + 1); }
  throw new Error(name + ' unterminated');
};
const CTL = read('public/control.html'), API = read('public/store-api.js'), CSS = read('public/team-status.css');
const TS = require('../public/team-status.js');
const NOW = Date.parse('2026-11-18T10:00:00Z'), H = 3600e3, D = 24 * H;
const iso = (ms) => new Date(ms).toISOString();

/* ---------------------------------------------------------------- 1. team-status.js */
await t('member(): an Add user login reads "Added by admin – hasn’t signed in yet" + "Temporary password unused"', () => {
  const s = TS.member({ created_at: iso(NOW - 2 * D) }, { last_sign_in_at: null, temp_password: true, joined_at: iso(NOW - 2 * D) }, NOW);
  assert.equal(s.key, 'never'); assert.equal(s.label, 'Added by admin – hasn’t signed in yet');
  assert.match(s.detail, /^Temporary password unused · Added /);
  assert.match(s.title, /Add user/); assert.match(s.title, /Send sign-in link/);
  const l = TS.member({}, { last_sign_in_at: null, temp_password: true, joined_at: iso(NOW - 2 * D), signin_link_at: iso(NOW - 5 * 60e3) }, NOW);
  assert.match(l.detail, /Temporary password unused · sign-in link sent 5 min ago · Added /);
  const p = TS.member({}, { last_sign_in_at: null, needs_password: true, joined_at: iso(NOW - D), signin_link_at: iso(NOW - H) }, NOW);
  assert.equal(p.key, 'setup'); assert.match(p.detail, /sign-in link sent 1 hour ago/); assert.match(p.title, /Send sign-in link/);
  assert.equal(TS.member({}, { last_sign_in_at: null, joined_at: iso(NOW - D) }, NOW).label, 'Signed up – never signed in');
});
await t('signInHelp(): row button only for never / no password; View for anyone else; temp only admins + can_new_temp; deactivated = reactivate first', () => {
  const never = { key: 'never' }, setup = { key: 'setup' }, act = { key: 'active' }, off = { key: 'off' };
  const a = { can_new_temp: true, signin_link_at: iso(NOW) };
  assert.deepEqual(TS.signInHelp(never, a, { isAdmin: true }), { row: true, link: true, temp: true, reactivateFirst: false, linkSentAt: a.signin_link_at, why: TS.signInHelp(never, a, { isAdmin: true }).why });
  assert.equal(TS.signInHelp(setup, {}, { isAdmin: true }).row, true);
  const h = TS.signInHelp(act, { can_new_temp: false }, { isAdmin: true }); assert.equal(h.row, false); assert.equal(h.link, true); assert.equal(h.temp, false);
  assert.equal(TS.signInHelp(never, a, { canEdit: true }).temp, false, 'Users edit (not admin): no temp');
  assert.equal(TS.signInHelp(never, a, { isAdmin: true, self: true }).link, false, 'never yourself');
  assert.equal(TS.signInHelp(never, null, { isAdmin: true }).link, false, 'no 0379 facts: nothing offered');
  assert.equal(TS.signInHelp(never, a, {}).link, false, 'no rights: nothing');
  const o = TS.signInHelp(off, a, { isAdmin: true }); assert.equal(o.reactivateFirst, true); assert.equal(o.link, false); assert.equal(o.why, 'Reactivate first, then send a sign-in link.');
  assert.equal(TS.signInHelp(never, a, { isAdmin: true, deactivated: true }).reactivateFirst, true);
});

/* ---------------------------------------------------------------- 2. control.html */
await t('rows: Send sign-in link on never-signed-in rows; one who-cell with e-mail + phone + job; 4 columns; no Phone / Job title columns', () => {
  assert.match(CTL, /const head=`<tr><th scope="col">Name<\/th><th scope="col">Role<\/th><th scope="col">Account<\/th><th scope="col"><span class="sr-only">Actions<\/span><\/th><\/tr>`;/);
  assert.doesNotMatch(CTL, /class="ucph"|class="ucjob"|data-label="Phone"|data-label="Job title"/);
  assert.match(CTL, /<div class="ucsub ucmeta">\$\{meta\}<\/div>/);
  // R211: the row's buttons come from HelmTeamStatus.rowActions (which uses signInHelp) - "link" = Send sign-in link, primary
  assert.match(CTL, /case "link": return `<button type="button" class="btn sm\$\{p\} ucLink"/);
  assert.match(CTL, /const ra=RA\?RA\(st, o\.acct&&o\.acct\.byId\?o\.acct\.byId\[ucId\(u\)\]:null, \{ self:!!self, owner:isOwner\(u\), deactivated:isOff\(u\), canEdit:o\.canEdit, isAdmin:o\.canEdit \}\)/);
  assert.match(CTL, /tb\.querySelectorAll\("\.ucLink"\)\.forEach\(btn=>btn\.addEventListener\("click", \(\)=>\{ const u=rowOf\(btn\.closest\("tr"\)\); if\(u\) sendSignInLink\(u, btn\); \}\)\);/);
});
await t('layout: grid rows from 640px (no table mode), two-line / one-column on narrow cards, nothing fixed wider than the card', () => {
  assert.match(CTL, /@media \(min-width:640px\)\{\n    #pane-users \.utable\.ucm,#pane-users \.utable\.ucm>tbody\{display:block;width:100%\}/);
  assert.match(CTL, /grid-template-columns:minmax\(0,1fr\) 170px minmax\(150px,210px\) minmax\(0,auto\);grid-template-areas:"who role prof act"/);
  assert.match(CTL, /@container ucm \(max-width:879\.98px\)\{\n      #pane-users \.utable\.ucm tr\.ucr\{grid-template-columns:minmax\(0,1fr\) auto;grid-template-areas:"who role" "prof act"\}/);
  assert.match(CTL, /@container ucm \(max-width:519\.98px\)\{\n      #pane-users \.utable\.ucm tr\.ucr\{grid-template-columns:minmax\(0,1fr\);grid-template-areas:"who" "role" "prof" "act"\}/);
  assert.match(CTL, /\.ucwt \.ucsub\{overflow-wrap:anywhere;word-break:break-word;white-space:normal\}/, 'e-mails wrap, never cut off');
  assert.doesNotMatch(CTL, /\.utable\.ucm td\.dn\{width:34%;min-width:210px/);
  assert.doesNotMatch(CSS, /td\.ucph|td\.ucjob/);
});
await t('Send sign-in link / New temporary password / Reactivate helpers: guard, rate-limit sentence, temp shown once via DOM only', () => {
  const s = fnSrc(CTL, 'sendSignInLink');
  assert.match(s, /BPStore\.auth\.admin\.sendSignInLink\(id\)/); assert.match(s, /r\.code==="rate_limited"/); assert.match(s, /await renderUsers\(\);/);
  const tp = fnSrc(CTL, 'newTempPassword');
  assert.match(tp, /BPUI\.confirm\(/); assert.match(tp, /BPStore\.auth\.admin\.newTempPassword\(id\)/); assert.match(tp, /umShowTemp\("New temporary password for", email/);
  assert.doesNotMatch(tp, /toast\([^)]*temp_password/, 'the password never goes into a toast');
  const show = fnSrc(CTL, 'umShowTemp');
  assert.doesNotMatch(show, /innerHTML/); assert.match(show, /code\.textContent=tp;/);
  const re = fnSrc(CTL, 'reactivateMember');
  assert.match(re, /BPStore\.team\.reactivate\(id\)\); await renderUsers\(\);/);
  assert.match(re, /use “Send sign-in link” on their row/);
});
await t('View panel: Send sign-in link, New temporary password (admins, can_new_temp), deactivated -> "Reactivate first" + Reactivate, Forgot password hint', () => {
  const v = fnSrc(CTL, 'viewMember');
  assert.match(v, /const help=TS\.signInHelp\?TS\.signInHelp\(st, a, \{ self, isAdmin, canEdit:isAdmin, deactivated:off \}\):null;/);
  assert.match(v, /\["Getting in", help&&help\.reactivateFirst\?"Reactivate first, then send a sign-in link\.":help&&help\.link\?help\.why\+" They can also use “Forgot password\?” on the sign-in page with this e-mail\.":""\]/);
  assert.match(v, /label:"Send sign-in link", primary:!!help\.row, onClick:\(b\)=>sendSignInLink\(u, b\)/);
  assert.match(v, /label:"New temporary password", onClick:\(b\)=>newTempPassword\(u, b\)/);
  assert.match(v, /label:"Reactivate", primary:true, onClick:\(b\)=>reactivateMember\(u, b\)/);
});
await t('"Which should I use?" box + Learn more; "Add user (create login now)"; Invite marked Recommended', () => {
  assert.match(CTL, /<div class="um-which" id="um_which">\s*<p class="um-which-t"><b>Which should I use\?<\/b> <b>Invite by email link<\/b> \(recommended\)/);
  assert.match(CTL, /<details class="um-which-more"><summary>Learn more<\/summary>/);
  for (const k of ['Save as a record only', 'Save and invite to sign in', 'New temporary password', 'needs two-step sign-in on your own account']) assert.ok(CTL.includes(k), k);
  // R211: Add user now sits behind "More options" with the no-e-mail warning between heading and form
  assert.match(CTL, /<h4 class="um-add-h" id="um_add_h">Add user \(create login now\)<\/h4>\s*<p class="um-warn"[^>]*>[\s\S]*?<\/p>\s*<form id="um_add" class="addrow s-0dff578" novalidate aria-labelledby="um_add_h">/);
  assert.match(CTL, /<h4 class="um-invite-h" id="inv_h">Invite by email link <span class="tag um-rec">Recommended<\/span><\/h4>/);
  assert.match(CTL, /no e-mail is sent\. Share it with the person/);
});
await t('two-step up front: picking Admin (Add user OR invite) without two-step shows the note + "Set up two-step now"; rule unchanged', () => {
  assert.match(CTL, /<div class="um-2step" id="um_2step" role="note" hidden><\/div>/);
  assert.match(CTL, /<div class="um-2step" id="inv_2step" role="note" hidden><\/div>/);
  assert.match(CTL, /const UM_2STEP_ROLES=\["admin"\];/);
  const p = fnSrc(CTL, 'um2StepPaint');
  assert.match(p, /if\(!UM_2STEP_ROLES\.includes\(sel\.value\)\|\|umMy2Step!==false\)\{ box\.hidden=true;/, 'only when two-step is known to be OFF');
  assert.match(p, /for “Add user” and for “Invite by email link” alike/);
  assert.match(p, /A\.openTwoStepSetup\(/); assert.doesNotMatch(p, /innerHTML/);
  assert.match(fnSrc(CTL, 'umMyTwoStep'), /BPStore\.auth\.mfa\.verifiedTotp\(\)/);
  assert.match(fnSrc(CTL, 'initUsers'), /um2StepWire\(\);/);
  assert.match(API, /async createUserTemp\(email, role\) \{[\s\S]{0,200}return withStepUp\(/, 'Add user still goes through the two-step step-up');
});

/* ---------------------------------------------------------------- 3. store-api.js */
await t('sendSignInLink: 0379 check first, then the Supabase reset e-mail to the login address; failed send lifts the wait; captcha / Google-only', () => {
  const s = API.slice(API.indexOf('async sendSignInLink(userId)'), API.indexOf('async newTempPassword(userId)'));
  assert.match(s, /supa\.rpc\("team_signin_link_request", \{ p_user: userId \}\)/);
  assert.match(s, /if \(!data \|\| data\.ok !== true\) return data/);
  assert.match(s, /supa\.auth\.resetPasswordForEmail\(scrubEmail\(data\.email\), \{ redirectTo: location\.origin \+ "\/reset-password" \}\)/);
  assert.match(s, /supa\.rpc\("team_signin_link_failed", \{ p_id: data\.id \}\)/);
  assert.ok(s.indexOf('team_signin_link_request') < s.indexOf('resetPasswordForEmail'));
  assert.match(s, /if \(CAPTCHA\) return fail\(/); assert.match(s, /staffGoogleOnlyFor\(data\.email\)/);
  assert.match(API, /async newTempPassword\(userId\) \{\s*if \(!supa\) throw new Error\("Supabase not configured"\);\s*return withStepUp\(async \(\) => \{ const \{ data, error \} = await supa\.rpc\("team_temp_password_reset", \{ p_user: userId \}\);/);
});
await t('updatePassword: a reset-link (recovery) password change also lifts "must change password" (server allows it only once off the temp one)', () => {
  const u = API.slice(API.indexOf('async updatePassword(newPassword, opts)'), API.indexOf('recovery: {', API.indexOf('async updatePassword(newPassword, opts)')));
  assert.match(u, /if \(recovery\) \{\s*try \{ const \{ error: ce \} = await supa\.rpc\("clear_password_change_required"\);/);
  assert.ok(u.indexOf('lsDel(RECOVERY_KEY)') < u.indexOf('clear_password_change_required'), 'only after the new password is saved');
});

/* ---------------------------------------------------------------- 4. 0379 + release files + pins */
const MIG = read('supabase/migrations/0379_r202_signin_help.sql'), APPLY = read('supabase/APPLY-0379.sql');
await t('0379: admin / Users edit for the link, admins for temp, own studio, not deactivated, not yourself, 10-minute limit, log, nothing deleted; ASCII', () => {
  assert.match(MIG, /create or replace function public\.team_signin_link_request\(p_user uuid\)[\s\S]{0,700}coalesce\(public\.is_admin\(\), false\) or coalesce\(public\.has_area\('users', 'edit'\), false\)/);
  assert.match(MIG, /create or replace function public\.team_temp_password_reset\(p_user uuid\)[\s\S]{0,500}not coalesce\(public\.is_admin\(\), false\) then raise exception 'not authorized'/);
  assert.match(MIG, /u\.last_sign_in_at is null and u\.email_confirmed_at is not null/);
  assert.match(MIG, /a155_admin_created a where a\.user_id = p_user and a\.org_id = p_org and a\.released_at is null/);
  assert.equal((MIG.match(/interval '10 minutes'/g) || []).length >= 3, true);
  assert.match(MIG, /Reactivate them first, then send a sign-in link\./);
  assert.doesNotMatch(MIG.replace(/--.*$/gm, ''), /\b(delete|truncate|drop)\b\s/i, 'nothing deleted or dropped');
  assert.match(MIG, /alter table public\.team_signin_help enable row level security;/);
  // privacy: studio data, emptied by the free-trial purge (0184) like the other studio tables
  assert.match(MIG, /create table if not exists public\.team_signin_help \(\n  id         bigserial primary key,\n  org_id     uuid not null,/);
  assert.match(MIG, /else execute replace\(v_def, '''notifications''', '''notifications'', ''team_signin_help'''\); end if;/);
  assert.match(APPLY, /'07 free-trial purge empties team_signin_help with the studio/);
  assert.match(MIG, /-- r199-0378: account status/, 'the 0378 marker stays on the re-issued status body');
  assert.doesNotMatch(MIG, /[^\x00-\x7F]/); assert.doesNotMatch(APPLY, /[^\x00-\x7F]/);
});
await t('APPLY-0379: begin; the migration verbatim; one all-true check list; commit - paste-safe', () => {
  assert.ok(APPLY.includes(MIG.trim()));
  assert.match(APPLY, /^-- APPLY-0379[^\n]*\n(--[^\n]*\n)*begin;\n/);
  assert.match(APPLY, /\nselect item, ok from \(values\n[\s\S]*\) v\(item, ok\) order by item;\ncommit;\n$/);
  assert.doesNotMatch(APPLY, /temp table|set local|set_config|\\set|\\ir/i);
});
await t('MANIFEST, checker override, run-all, release lists, CHECK-PROD carry 0379', () => {
  assert.ok(read('supabase/migrations/MANIFEST').includes('forward  supabase/migrations/0379_r202_signin_help.sql'));
  assert.match(read('supabase/check-prod-overrides.json'), /"0379": \{ "note": "Users & invites sign-in help[^\n]*"marker public\.team_signin_link_request\(uuid\) r202-0379"/);
  assert.match(read('scripts/db-test/run-all.sh'), /run "r202-signin-help-0379" "R202-SIGNIN-HELP-0379: ALL PASS \\\(22\/22\\\)" psql -q -f tests\/db\/r202-signin-help-0379\.sql/);
  for (const f of ['test/release-1019.test.mjs', 'test/release-1020.test.mjs']) assert.match(read(f), /'0378', '0379'[,\]]/, f);
  assert.match(read('supabase/CHECK-PROD-MIGRATIONS.sql'), /0379_r202_signin_help/);
});
await t('asset pins: store-api v372 everywhere, team-status.js / .css v2 on Settings + Staff, page-tours has the new steps', () => {
  for (const f of readdirSync(new URL('../public/', import.meta.url)).filter((x) => x.endsWith('.html'))) {
    const m = read('public/' + f).match(/store-api\.js\?v=(\d+)/); if (m) assert.equal(m[1], '375', f);
  }
  for (const f of ['public/control.html', 'public/staff.html']) { assert.match(read(f), /<script src="team-status\.js\?v=3"><\/script>/, f); assert.match(read(f), /<link rel="stylesheet" href="team-status\.css\?v=3">/, f); }   // R211: v3
  const PT = read('public/page-tours.js');
  for (const s of ['"#um_which"', '"#um_rows .ucView"', '"#um_more"']) assert.ok(PT.includes('sel: ' + s), s);   // R211: Add user step -> More options
});

console.log(`r202-signin-link: ${n} passed`);
