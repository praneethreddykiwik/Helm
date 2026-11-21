// R228 (owner 18 Nov 2026: "organise this properly and cleanly") - Settings -> Users & invites layout.
// Frontend only: no database change, no change to what any button does or who may do it.
//   1. page header "Invite people" (moved into the Settings header by control-split.js; data-cs-head-for) + folding invite panel
//   2. the long "Which should I use?" box -> a one-line hint + Learn more (inside the invite panel)
//   3. members: filter tabs with counts (ucCounts), Name | Role | Status | Two-step | View / Edit / "..." menu
//   4. open invitations = rows (Invited tab); the separate Pending invites card only without 0378
//   5. Transfer ownership in its own "Danger zone" card (HelmTeam.paint transferBox)
//   6. the "..." menu: HelmTeamStatus.rowMenus (keyboard: arrows / Home / End / Esc / Tab; item closes first)
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const rd = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0;
const t = async (name, fn) => { try { await fn(); n++; console.log('  ok ' + name); } catch (e) { console.error('  FAIL ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; } };
const C = rd('public/control.html'), CS = rd('public/control-split.js'), CSC = rd('public/control-split.css'), TSF = rd('public/team-safety.js'),
  TST = rd('public/team-status.js'), TSC = rd('public/team-status.css'), PT = rd('public/page-tours.js');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function fnSrc(src, name) {
  const i = src.indexOf('function ' + name + '('); assert.ok(i >= 0, name);
  let d = 0; for (let k = src.indexOf('{', i); k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}' && !--d) return src.slice(i, k + 1); }
  throw new Error('unbalanced ' + name);
}
const NOW = Date.parse('2026-11-18T09:00:00Z'), D = 864e5, iso = (x) => new Date(x).toISOString();
function loadTS() { const w = {}; vm.runInNewContext(TST, { window: w, globalThis: w, module: undefined }); return w.HelmTeamStatus; }
function table() {
  const ctx = { esc, HelmTeamStatus: loadTS() };
  vm.runInNewContext('const ucId=(u)=>u.user_id||u.id;' + ['ucDate', 'ucShownName', 'ucNameHtml', 'ucPhone', 'ucInitials', 'ucPrivateVisible', 'ucMatches', 'ucState', 'ucAcctCell', 'ucInviteRows', 'ucTable', 'ucCounts']
    .map((f) => fnSrc(C, f)).join('\n') + '\nglobalThis.T=ucTable; globalThis.N=ucCounts;', ctx);
  return ctx;
}
const ROW = (i, o) => Object.assign({ id: 'u' + i, email: 'p' + i + '@studio.test', full_name: 'Person ' + i, role: 'crew', phone: '+919876543210', complete: true, created_at: '2026-09-01', whatsapp_same: true }, o || {});
const ACCT = { byId: { u1: { user_id: 'u1', last_sign_in_at: iso(NOW - 3 * D) }, u2: { user_id: 'u2', last_sign_in_at: null, temp_password: true, joined_at: iso(NOW - D) },
  u3: { user_id: 'u3', last_sign_in_at: iso(NOW - D), deactivated: true } },
  invites: [{ id: 'i1', email: 'new@studio.test', role: 'manager', created_at: iso(NOW - D), expires_at: iso(NOW + 6 * D) },
    { id: 'i2', email: 'old@studio.test', role: 'crew', created_at: iso(NOW - 9 * D), expires_at: iso(NOW - 2 * D), expired: true }] };
const KEYS = ['', 'active', 'invited', 'never', 'incomplete', 'off'];

/* ---------------------------------------------------------------- 1. header button + invite panel */
await t('page header: one primary "Invite people" button (moved into the Settings header), opening the invite panel', () => {
  assert.match(C, /<button type="button" class="btn primary um-invite-btn" id="um_invite_btn" data-cs-head-for="users" aria-expanded="false" aria-controls="um_invite">/);
  assert.match(C, /<section class="um-invite" id="um_invite" aria-labelledby="inv_h" data-cs-reveal hidden>/);
  assert.match(C, /<button type="button" class="um-invite-x" id="um_invite_x" aria-label="Close the invite panel">/);
  assert.match(C, /\$\("#um_invite_btn"\)\.addEventListener\("click",\(\)=>\{ umInvitePanel\(\$\("#um_invite"\)\.hidden, true\); \}\);/);
  assert.match(C, /p\.hidden=!open; if\(b\) b\.setAttribute\("aria-expanded", String\(!!open\)\);/);
  assert.match(C, /\$\("#um_invite"\)\.addEventListener\("cs:reveal",\(\)=>umInvitePanel\(true\)\);/, 'a settings search hit inside opens it');
  assert.match(C, /box\.hidden=false; umInvitePanel\(true\);/, 'a refusal message is never hidden in a closed panel');
  assert.match(C, /if\(ucRows\.length<=1&&!\(ucAcct&&ucAcct\.invites&&ucAcct\.invites\.length\)\) umInvitePanel\(true\);/, 'a studio of one sees it open');
  // control-split: the header slot, per-section, never touching `hidden`
  assert.match(CS, /Array\.prototype\.forEach\.call\(main\.querySelectorAll\("\[data-cs-head-for\]"\),function\(b\)\{ hA\.appendChild\(b\); \}\);/);
  assert.match(CS, /b\.classList\.toggle\("cs-off", b\.getAttribute\("data-cs-head-for"\)!==key\)/);
  assert.match(CS, /main\.setAttribute\("data-cs-cur",key\); paintHeadActs\(key\);/);
  assert.match(CS, /var rv=node\.closest&&node\.closest\("\[data-cs-reveal\]"\); if\(rv&&rv\.hidden\)\{ try\{ rv\.dispatchEvent\(new CustomEvent\("cs:reveal",\{bubbles:true\}\)\); \}catch\(x\)\{\} \}/);
  assert.match(CSC, /\.cs-head-acts:empty,\.cs-head-acts>\.cs-off\{display:none!important\}/);
  // every id the page / tests / tours use is still there exactly once
  for (const id of ['inv_add', 'inv_email', 'inv_role', 'inv_submit', 'inv_err', 'inv_2step', 'inv_out', 'inv_link', 'inv_copy', 'um_more', 'um_add', 'um_email', 'um_role', 'um_submit', 'um_err', 'um_2step',
    'um_which', 'seat_meter', 'team_safety', 'team_work', 'uc_tools', 'uc_q', 'uc_f', 'uc_count', 'um_head', 'um_rows', 'inv_card', 'inv_rows', 'umsg', 'ts_danger', 'ts_xfer', 'uc_tabs'])
    assert.equal((C.match(new RegExp('id="' + id + '"', 'g')) || []).length, 1, id);
});
await t('the "Which should I use?" text is one line + Learn more (nothing of it is lost)', () => {
  const w = C.slice(C.indexOf('<div class="um-which" id="um_which">'), C.indexOf('<details class="um-more" id="um_more" hidden>'));
  assert.match(w, /<p class="um-which-t">[^\n]*<\/p>\n/, 'one short line');
  for (const k of ['Invite by email link</b> (recommended)', 'Add user (create login now)', 'More options', 'temporary password', 'Resend invite', 'Send sign-in link', 'Reactivate', 'Save as a record only',
    'Save and invite to sign in', 'two-step sign-in on your own account', 'New temporary password', 'link works 7 days']) assert.ok(w.includes(k), k);
});

/* ---------------------------------------------------------------- 2. members table */
await t('table: Name | Role | Status | Two-step | actions; the one main step under the status; View + Edit + "..." for the rest', () => {
  const { T } = table();
  const rows = [ROW(1, { role: 'admin' }), ROW(2, { complete: false, phone: '' }), ROW(3)];
  const r = T(rows, { profiles: true, meId: 'u1', roles: ['admin', 'crew'], roleLabel: (x) => x, canEdit: true, q: '', filter: '', acct: ACCT, now: NOW, twoStep: { u1: true } });
  assert.equal(r.head, '<tr><th scope="col">Name</th><th scope="col">Role</th><th scope="col">Status</th><th scope="col">Two-step</th><th scope="col"><span class="sr-only">Actions</span></th></tr>');
  const row = (id) => r.body.slice(r.body.indexOf('data-id="' + id + '"'), r.body.indexOf('</tr>', r.body.indexOf('data-id="' + id + '"')));
  // me: signed in -> chip only, no "Joined" line, no menu (nothing else to do on my own row)
  assert.match(row('u1'), /<td class="ucprof" data-label="Status"><span class="ucst ucst-ok"[^>]*>Last signed in 3 days ago<\/span><\/td>/);
  assert.match(row('u1'), /<td class="uctwo" data-label="Two-step"><span class="ts-badge on"[^>]*>Two-step: on<\/span><\/td>/);
  assert.doesNotMatch(row('u1'), /ucMore|ucmenu/);
  // never signed in: Send sign-in link right under the status; Remove access in the menu
  assert.match(row('u2'), /<div class="ucnext"><button type="button" class="btn sm primary ucLink"/);
  assert.match(row('u2'), /<td class="ucact"><button type="button" class="btn sm ucView"[^>]*>View<\/button><button type="button" class="btn sm ucEdit"[^>]*>Edit<\/button><div class="ucmw"><button type="button" class="btn sm ucMore" aria-haspopup="menu" aria-expanded="false" aria-controls="(ucmn-\d+)" aria-label="More actions for p2@studio\.test"/);
  assert.match(row('u2'), /<div class="ucmenu" id="ucmn-\d+" role="menu" aria-label="More actions for p2@studio\.test" hidden><button type="button" role="menuitem" tabindex="-1" class="ucmi rm" data-never="1"[^>]*>Remove access<\/button><\/div>/);
  assert.match(row('u2'), /<td class="uctwo" data-label="Two-step"><\/td>/, 'no two-step badge for a non-admin (empty cell, hidden on phones)');
  // deactivated: Reactivate under the status, Open work in the menu
  assert.match(row('u3'), /<div class="ucnext"><button type="button" class="btn sm primary ucReact"/);
  assert.match(row('u3'), /class="ucmi ucWork"[^>]*>Open work<\/button>/);
  // ids of the menus are unique; every menu has a trigger that points at it
  const ids = [...r.body.matchAll(/class="ucmenu" id="(ucmn-\d+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length); for (const id of ids) assert.ok(r.body.includes('aria-controls="' + id + '"'), id);
  // invites: Resend under the status; Copy link + Cancel invite in the menu; View stays
  assert.match(r.body, /data-inv="i1"[\s\S]*?<div class="ucnext"><button type="button" class="btn sm primary ucInvResend"[^>]*>Resend invite<\/button><\/div>[\s\S]*?class="ucmi ucInvCopy"[\s\S]*?class="ucmi ucInvCancel"/);
  assert.match(r.body, /data-inv="i1"[\s\S]*?<td class="uctwo" data-label="Two-step"><\/td>/);
  // view-only: no menu items that change anything
  const ro = T(rows, { profiles: true, meId: 'u9', roles: ['crew'], q: '', filter: '', acct: ACCT, now: NOW });
  assert.doesNotMatch(ro.body, /ucEdit|ucInvResend|ucInvCancel|class="ucmi rm"|ucLink|ucReact/);
});
await t('the row wiring is unchanged: menu items keep their classes, so the same listeners on #um_rows handle them', () => {
  for (const c of ['.ucView', '.ucInvResend', '.ucInvCancel', '.ucInvCopy', '.roleSel', '.ucEdit', '.rm', '.ucReact', '.ucLink', '.ucWork'])
    assert.ok(C.includes('tb.querySelectorAll("' + c + '").forEach'), c);
  assert.match(C, /const C=\(c\)=>inMenu\?`role="menuitem" tabindex="-1" class="ucmi \$\{c\.replace\(\/\^btn sm \?\/,""\)\}"`:`class="\$\{c\}"`;/);
});
await t('filter tabs with counts: same rules as the filter (ucCounts), zero tabs left out, #uc_f keeps the value', () => {
  const { T, N } = table();
  const rows = [ROW(1), ROW(2, { complete: false }), ROW(3)];
  const team = { isOff: (id) => id === 'u3', ownerId: null, pending: {} };
  const c = JSON.parse(JSON.stringify(N(rows, { acct: ACCT, now: NOW, team }, KEYS)));
  assert.deepEqual(c, { '': 5, active: 1, invited: 2, never: 1, incomplete: 1, off: 1 });
  for (const k of KEYS) assert.equal(T(rows, { profiles: true, meId: 'u1', roles: ['crew'], q: '', filter: k, acct: ACCT, now: NOW, team, canEdit: true }).shown, c[k], 'tab ' + k);
  assert.deepEqual(JSON.parse(JSON.stringify(N(rows, { now: NOW }, KEYS))), { '': 3, active: 3, invited: 0, never: 0, incomplete: 1, off: 0 }, 'without 0378: no invite rows');
  assert.match(C, /const UC_TABS=\[\["","Everyone"\],\["active","Active"\],\["invited","Invited"\],\["never","Not signed in"\],\["incomplete","Incomplete profile"\],\["off","Deactivated"\]\];/);
  assert.match(C, /if\(f&&f!==cur&&!cnt\[f\]\) return;/);
  assert.match(C, /b\.setAttribute\("aria-pressed", String\(f===cur\)\);/);
  assert.match(C, /<div class="uc-tabs" id="uc_tabs" role="group" aria-label="Show" hidden><\/div>/);
  assert.match(C, /<select id="uc_f" aria-label="Show" hidden>/);
  assert.match(C, /<span class="uccount sr-only" id="uc_count" role="status" aria-live="polite"><\/span>/, 'the old text count stays for screen readers');
  assert.match(C, /if\(ucProfiles\) ucTabsPaint\(ucCounts\(ucRows, \{ team, acct:ucAcct, now:Date\.now\(\) \}, UC_TABS\.map\(x=>x\[0\]\)\)\);/);
});
await t('pending invites: rows of the table (Invited tab); the separate card only without the account status', () => {
  assert.match(C, /<div class="card" id="inv_card" hidden>/);
  assert.match(C, /\{ const ic=\$\("#inv_card"\); if\(ic\) ic\.hidden=!!ucAcct; \}/);
  assert.match(C, /if\(typeof renderInvites==="function"\) renderInvites\(\);/, 'still loaded (duplicate-invite check + seats)');
});
await t('CSS: column headings from 800px, five fixed columns, tokens only (no hard-coded green) for the new parts', () => {
  assert.match(C, /@container ucm \(min-width:800px\)\{\n      #pane-users \.utable\.ucm>thead\{position:static/);
  assert.equal((C.match(/minmax\(0,1fr\) 150px 190px 118px 132px/g) || []).length, 2, 'rows and headings share one template');
  const r228 = TSC.slice(TSC.indexOf('---- R228'));
  assert.ok(r228.length > 200);
  assert.doesNotMatch(r228.replace(/var\([^)]*\)/g, ''), /#0f7a43|#e7f6ee|#047857|#059669|#2eb872/i, 'no hard-coded green outside a var() fallback');
  assert.match(r228, /\.uc-tab\[aria-pressed="true"\]\{background:var\(--panel/);
  assert.match(r228, /\.ucmenu\{position:fixed;z-index:1300/);
  assert.match(r228, /:focus-visible\{outline:2px solid var\(--accent/);
  assert.match(r228, /@media \(max-width:639\.98px\)/);
});

/* ---------------------------------------------------------------- 3. Danger zone */
function fakeDoc() {
  class El {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.listeners = {}; this.textContent = ''; this.parentNode = null; this.hidden = false; }
    get firstChild() { return this.children[0] || null; }
    appendChild(c) { if (typeof c === 'object') { c.parentNode = this; this.children.push(c); } return c; }
    removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; }
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); }
    addEventListener(k, f) { this.listeners[k] = f; }
    set className(v) { this.attrs.class = v; } get className() { return this.attrs.class || ''; }
    find(fn) { for (const c of this.children) { if (fn(c)) return c; const x = c.find && c.find(fn); if (x) return x; } return null; }
    text() { return this.textContent + this.children.map((c) => (c.text ? c.text() : '')).join(' '); }
  }
  return { createElement: (t) => new El(t), createTextNode: (s) => { const e = new El('#text'); e.textContent = s; return e; }, El };
}
await t('R229: Transfer ownership is OFF - the owner gets no block (Danger zone card stays empty + hidden), no folded box either', () => {
  assert.match(TSF, /const TRANSFER_OWNERSHIP_ON = false;/);
  const d = fakeDoc(), w = {};
  vm.runInNewContext(TSF, { window: w, globalThis: w, document: d, encodeURIComponent });
  const OV = { owner_id: 'u1', i_am_owner: true, is_admin: true, me: 'u1', my_two_step: true, deactivated: [], pending: [], transfer: null, admins: [{ user_id: 'u1', name: 'Me' }, { user_id: 'u2', name: 'Arjun' }] };
  const box = d.createElement('div'), xb = d.createElement('div');
  w.HelmTeam.paint(box, OV, { store: {}, transferBox: xb });
  assert.equal(xb.children.length, 0); assert.equal(box.hidden, true);
  const box2 = d.createElement('div');
  w.HelmTeam.paint(box2, OV, { store: {} });
  assert.equal(box2.children.length, 0); assert.equal(box2.hidden, true);
});
await t('team-safety.js (switch turned back on): transferBox -> Transfer ownership as its own block (no stray folded line); without it the old box', () => {
  const d = fakeDoc(), w = {};
  vm.runInNewContext(TSF.replace('const TRANSFER_OWNERSHIP_ON = false;', 'const TRANSFER_OWNERSHIP_ON = true;'), { window: w, globalThis: w, document: d, encodeURIComponent });
  const H = w.HelmTeam;
  const OV = { owner_id: 'u1', i_am_owner: true, is_admin: true, me: 'u1', my_two_step: true, deactivated: [], pending: [], transfer: null, admins: [{ user_id: 'u1', name: 'Me' }, { user_id: 'u2', name: 'Arjun' }] };
  const box = d.createElement('div'), xb = d.createElement('div');
  H.paint(box, OV, { store: {}, transferBox: xb });
  assert.equal(box.hidden, true, 'nothing waiting -> the banner box stays hidden');
  assert.equal(xb.children.length, 1);
  const blk = xb.children[0];
  assert.equal(blk.tagName, 'DIV'); assert.equal(blk.className, 'tsTransfer tsTransferZ');
  assert.equal(blk.children[0].tagName, 'H4'); assert.equal(blk.children[0].textContent, 'Transfer ownership');
  assert.ok(blk.find((c) => c.id === 'ts_to') && blk.find((c) => c.id === 'ts_go'), 'same picker + Send hand-over button');
  // not the owner -> empty (the page hides the card)
  H.paint(box, Object.assign({}, OV, { i_am_owner: false, me: 'u2' }), { store: {}, transferBox: xb });
  assert.equal(xb.children.length, 0);
  // no transferBox (another caller): the folded <details> under the banners, as before
  const box2 = d.createElement('div');
  H.paint(box2, OV, { store: {} });
  assert.equal(box2.children[0].tagName, 'DETAILS'); assert.equal(box2.hidden, false);
  // the page: the card shows only when there is something in it
  assert.match(C, /<div class="card um-danger" id="ts_danger" aria-labelledby="ts_danger_h" hidden>\s*<h3 id="ts_danger_h">Danger zone<\/h3>\s*<div id="ts_xfer"><\/div>/);
  assert.match(C, /reload:renderUsers, transferBox:\$\("#ts_xfer"\) \}\);\n    \{ const dz=\$\("#ts_danger"\), xb=\$\("#ts_xfer"\); if\(dz\) dz\.hidden=!\(xb&&xb\.firstChild\); \}/);
  assert.ok(C.indexOf('id="ts_danger"') > C.indexOf('id="inv_card"') && C.indexOf('id="ts_danger"') < C.indexOf('<h3>Access control'), 'last card of Users & invites');
});

/* ---------------------------------------------------------------- 4. the "..." menu (keyboard) */
function menuWorld() {
  const listeners = { box: { click: [], keydown: [] }, doc: { click: [], scroll: [] }, win: { resize: [] } };
  let active = null;
  const mk = (cls, attrs, parent) => {
    const e = { cls, attrs: Object.assign({}, attrs), parent, kids: [], hidden: false, disabled: false, style: {}, isConnected: true,
      getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }, setAttribute(k, v) { this.attrs[k] = String(v); },
      focus() { active = this; }, closest(sel) { let x = this; while (x) { if (x.matches(sel)) return x; x = x.parent; } return null; },
      matches(sel) { if (sel === '.ucMore') return this.cls.includes('ucMore'); if (sel === '.ucmenu [role="menuitem"]') return this.attrs.role === 'menuitem' && !!(this.parent && this.parent.cls === 'ucmenu'); return false; },
      contains(o) { while (o) { if (o === this) return true; o = o.parent; } return false; },
      querySelectorAll() { return this.kids.filter((k) => k.attrs.role === 'menuitem'); },
      getBoundingClientRect() { return { left: 0, top: 0, right: 300, bottom: 100 }; }, offsetWidth: 200, offsetHeight: 80 };
    if (parent) parent.kids.push(e); return e;
  };
  const box = mk('tbody', {}); box.addEventListener = (k, f, cap) => listeners.box[k].push({ f, cap: !!cap });
  const btn = mk('btn sm ucMore', { 'aria-controls': 'm1', 'aria-expanded': 'false' }, box);
  const menu = mk('ucmenu', { id: 'm1', role: 'menu' }, box); menu.hidden = true;
  const items = ['Copy link', 'Cancel invite', 'Deactivate'].map((x) => mk('ucmi', { role: 'menuitem', tabindex: '-1', label: x }, menu));
  const doc = { getElementById: (id) => (id === 'm1' ? menu : null), documentElement: { clientWidth: 1000, clientHeight: 800 },
    addEventListener: (k, f) => listeners.doc[k].push(f) };
  const w = { document: doc, addEventListener: (k, f) => listeners.win[k].push(f) };
  vm.runInNewContext(TST, { window: w, globalThis: w, module: undefined });
  w.HelmTeamStatus.rowMenus(box); w.HelmTeamStatus.rowMenus(box);
  const fire = (kind, target, key) => { let stop = false; const ev = { target, key, preventDefault() {}, stopPropagation() { stop = true; } };
    const L = listeners.box[kind].slice().sort((a, b) => (b.cap ? 1 : 0) - (a.cap ? 1 : 0)); for (const l of L) l.f(ev);
    if (kind === 'click') for (const f of listeners.doc.click) f(ev); return ev; };
  return { box, btn, menu, items, fire, listeners, active: () => active, label: () => active && (active.attrs.label || active.cls) };
}
await t('"..." menu: opens on click with focus on the first item, arrows / Home / End move, Esc returns focus to "..."', () => {
  const W = menuWorld();
  assert.equal(W.listeners.box.click.length, 2, 'wired once, even when called twice');
  W.fire('click', W.btn);
  assert.equal(W.menu.hidden, false); assert.equal(W.btn.getAttribute('aria-expanded'), 'true'); assert.equal(W.label(), 'Copy link');
  W.fire('keydown', W.active(), 'ArrowDown'); assert.equal(W.label(), 'Cancel invite');
  W.fire('keydown', W.active(), 'End'); assert.equal(W.label(), 'Deactivate');
  W.fire('keydown', W.active(), 'ArrowDown'); assert.equal(W.label(), 'Copy link', 'wraps around');
  W.fire('keydown', W.active(), 'ArrowUp'); assert.equal(W.label(), 'Deactivate');
  W.fire('keydown', W.active(), 'Home'); assert.equal(W.label(), 'Copy link');
  W.fire('keydown', W.active(), 'Escape');
  assert.equal(W.menu.hidden, true); assert.equal(W.btn.getAttribute('aria-expanded'), 'false'); assert.equal(W.active(), W.btn);
  // ArrowUp on the closed trigger opens on the LAST item; Tab closes back to the trigger
  W.fire('keydown', W.btn, 'ArrowUp'); assert.equal(W.label(), 'Deactivate');
  W.fire('keydown', W.active(), 'Tab'); assert.equal(W.menu.hidden, true); assert.equal(W.active(), W.btn);
  // a second click on "..." closes it
  W.fire('click', W.btn); W.fire('click', W.btn); assert.equal(W.menu.hidden, true);
});
await t('"..." menu: choosing an item closes it FIRST and focuses "..." (dialogs return focus to a visible control); click outside closes', () => {
  const W = menuWorld();
  W.fire('click', W.btn); W.fire('keydown', W.active(), 'ArrowDown');
  W.fire('click', W.items[2]);
  assert.equal(W.menu.hidden, true); assert.equal(W.active(), W.btn);
  W.fire('click', W.btn); assert.equal(W.menu.hidden, false);
  for (const f of W.listeners.doc.click) f({ target: { parent: null } });
  assert.equal(W.menu.hidden, true);
  W.fire('click', W.btn); for (const f of W.listeners.win.resize) f(); assert.equal(W.menu.hidden, true, 'resize closes');
  assert.match(TST, /rowMenus: rowMenus/);
  assert.match(C, /if\(window\.HelmTeamStatus&&HelmTeamStatus\.rowMenus\) HelmTeamStatus\.rowMenus\(\$\("#um_rows"\)\);/);
});

/* ---------------------------------------------------------------- 5. tour + pins */
await t('page tour (Settings -> Users & invites): <= 8 steps that point at the new layout', () => {
  const u = PT.slice(PT.indexOf('        users: ['), PT.indexOf('        access: ['));
  const steps = u.match(/\{ sel: /g) || [];
  assert.ok(steps.length >= 4 && steps.length <= 8, String(steps.length));
  for (const s of ['["#inv_email", "#um_invite_btn"]', '["#um_which", "#um_more"]', '"#uc_tools"', '"#um_rows"', '"#um_rows .btn.primary"', '"#um_rows .ucView"', '"#um_rows .ucMore"'])
    assert.ok(u.includes('sel: ' + s), s);
  assert.doesNotMatch(u, /#ts_danger/, 'R229: Transfer ownership is off - no Danger zone step');
  assert.doesNotMatch(u, /#um_rows \.ts-badge/, 'the badge step folded into Team members (Two-step column)');
});
await t('asset pins: control.html loads the new team-status / team-safety / control-split; staff.html the same team-status', () => {
  for (const f of ['public/control.html', 'public/staff.html']) {
    const h = rd(f); assert.match(h, /team-status\.js\?v=5"/, f); assert.match(h, /team-status\.css\?v=4"/, f);
  }
  assert.match(C, /team-safety\.js\?v=6"/); assert.match(C, /control-split\.js\?v=25"/); assert.match(C, /control-split\.css\?v=17"/);
});

console.log(`r228-users-page: ${n} test(s) passed.`);
