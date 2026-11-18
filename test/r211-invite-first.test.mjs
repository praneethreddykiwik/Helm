// r211-invite-first.test.mjs - R211 (owner 18 Nov 2026, Settings -> Users & invites):
//   1. team-status.js rowActions(): one obvious next step (primary) for every not-yet-active state - open / expired invite,
//      never signed in, no password yet, deactivated - and none for a normal signed-in member, yourself or the owner.
//   2. control.html: invite first (Add user behind "More options" with the no-e-mail warning), a deactivated member's
//      e-mail offers Reactivate (same studio) instead of a second login, the other-studio sentence names no studio,
//      a full-seats click says why.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ROOT = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');
let n = 0;
const t = (name, fn) => { try { fn(); n++; console.log('  ok ' + name); } catch (e) { console.error('  FAIL ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; } };
const TS = require('../public/team-status.js');
const CTL = read('public/control.html');
const keys = (a) => a.map((x) => x.key + (x.primary ? '*' : '')).join(' ');
const ADMIN = { canEdit: true, isAdmin: true };

t('rowActions: invitations - open = Resend* / Copy link / Cancel / View; expired = no Copy link; no Users edit = nothing', () => {
  assert.equal(keys(TS.rowActions({ key: 'invited' }, null, { invite: true, ...ADMIN })), 'resend* copy cancel view');
  assert.equal(keys(TS.rowActions({ key: 'expired' }, null, { invite: true, ...ADMIN })), 'resend* cancel view');
  assert.deepEqual(TS.rowActions({ key: 'invited' }, null, { invite: true, canEdit: false }), []);
});
t('rowActions: never signed in / no password yet = Send sign-in link* first, Remove access (not Deactivate)', () => {
  for (const key of ['never', 'setup']) {
    const r = TS.rowActions({ key }, { last_sign_in_at: null }, ADMIN);
    assert.equal(r[0].key, 'link'); assert.ok(r[0].primary, key);
    assert.ok(r.some((x) => x.key === 'remove'), key); assert.ok(!r.some((x) => x.key === 'deactivate'), key);
  }
  // yourself: no sign-in link to yourself, no remove
  const me = TS.rowActions({ key: 'never' }, null, { ...ADMIN, self: true });
  assert.ok(!me.some((x) => x.key === 'link' || x.key === 'remove'));
});
t('rowActions: deactivated = Reactivate* + Open work; never for yourself / the owner', () => {
  assert.equal(keys(TS.rowActions({ key: 'off' }, null, ADMIN)), 'react* work view edit');
  assert.equal(keys(TS.rowActions({ key: 'off' }, null, { ...ADMIN, owner: true })), 'view edit');
  assert.equal(keys(TS.rowActions({ key: 'active' }, null, { ...ADMIN, deactivated: true })), 'react* work view edit');
});
t('rowActions: signed in normally = no invite / sign-in actions, Deactivate; owner / self have no Deactivate; view-only = View', () => {
  assert.equal(keys(TS.rowActions({ key: 'active' }, { last_sign_in_at: '2026-11-01T00:00:00Z' }, ADMIN)), 'view edit deactivate');
  assert.equal(keys(TS.rowActions({ key: 'active' }, null, { ...ADMIN, owner: true })), 'view edit');
  assert.equal(keys(TS.rowActions({ key: 'active' }, null, { ...ADMIN, self: true })), 'view edit');
  assert.equal(keys(TS.rowActions({ key: 'active' }, null, { canEdit: false })), 'view');
  assert.equal(keys(TS.rowActions({ key: 'off' }, null, { canEdit: false })), 'view');
});
t('control.html: invite first, Add user behind "More options" (admins only) with the no-e-mail warning', () => {
  assert.ok(CTL.indexOf('id="inv_add"') < CTL.indexOf('id="um_more"'), 'invite form comes before More options');
  assert.match(CTL, /<details class="um-more" id="um_more" hidden>\s*<summary>More options<\/summary>/);
  assert.match(CTL, /<p class="um-warn" id="um_warn" role="note"><b>No e-mail is sent; you must give them the temporary password yourself\.<\/b>/);
  assert.match(CTL, /const mo=\$\("#um_more"\); if\(mo\) mo\.hidden=!isAdmin;/);
});
t('control.html: a deactivated member of THIS studio -> Reactivate offer (both forms, before and after the database answer)', () => {
  assert.equal((CTL.match(/const off=umOffMember\(\$\("#(um|inv)_email"\)\.value\); if\(off\)\{ umOfferReactivate\("(um|inv)", off\); return; \}/g) || []).length, 2);
  assert.match(CTL, /is already in your studio, but deactivated\. Reactivate them instead/);
  assert.match(CTL, /No new login and no second invite is made\./);
  assert.match(CTL, /Reactivate and send sign-in link/);
});
t('control.html: another studio - one sentence, names no studio, nothing moved', () => {
  const m = CTL.match(/const UM_OTHER_STUDIO="([^"]+)"/); assert.ok(m);
  assert.match(m[1], /a login can be in one studio at a time, and being deactivated there doesn't free it/);
  assert.doesNotMatch(m[1], /\$\{/);
});
t('control.html: a locked button on full seats says why', () => {
  assert.match(CTL, /function umSeatRefusal\(which, btn\)\{ if\(btn&&btn\.disabled&&btn\.title&&!btn\.getAttribute\("aria-busy"\)\)/);
});
console.log(`r211-invite-first: ${n} test(s) ${process.exitCode ? 'with failures' : 'passed'}.`);
