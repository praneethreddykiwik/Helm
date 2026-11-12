// r154h-wa-details.test.mjs - R154h: Integrations -> WhatsApp lost the typed WhatsApp Business Account ID, Phone number
// ID and token on leaving the page (the only save was Connect, and the server took all three or nothing). Now the IDs
// are saved on their own (0353, save_org_whatsapp_account without a token) and pre-filled every time, the token is never
// sent back (token_saved yes / no only), unsaved boxes ask before leaving, and the check answers short reason codes.
// Static + pure-logic + a small fake-DOM run of the card. Behaviour of the SQL: tests/db/r154h-wa-details-0353.sql;
// the edge function: tests/edge/wa-connect.test.ts.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const ROOT = new URL('..', import.meta.url);
const r = (p) => readFileSync(new URL(p, ROOT), 'utf8');
const require = createRequire(import.meta.url);
let n = 0;
const t = async (name, fn) => { try { await fn(); n++; console.log('  ok ' + name); } catch (e) { console.error('  FAIL ' + name + '\n' + (e && e.stack || e)); process.exit(1); } };

const M = r('supabase/migrations/0353_r154h_wa_details.sql'), A = r('supabase/APPLY-0353.sql'), mf = r('supabase/migrations/MANIFEST');
const code = (s) => s.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');

await t('0353: MANIFEST once, after 0337 and 0346, plain words, nothing dropped, safe to run twice; release lists', () => {
  const line = 'forward  supabase/migrations/0353_r154h_wa_details.sql';
  assert.equal(mf.split('\n').filter((l) => l === line).length, 1);
  assert.ok(mf.indexOf('forward  supabase/migrations/0337_r129_studio_whatsapp.sql') < mf.indexOf(line));
  assert.ok(mf.indexOf('forward  supabase/migrations/0346_r154_slug_skeleton_execute.sql') < mf.indexOf(line));
  assert.match(mf, /# 0353 \(R154h[^\n]*Nothing dropped or deleted\. Safe to run twice\./);
  for (const f of ['test/release-1019.test.mjs', 'test/release-1020.test.mjs']) assert.match(r(f), /'0353'(, '\d{4}')*\]/, f);
  assert.match(r('scripts/db-test/run-all.sh'), /run "r154h-wa-details-0353" "R154H-WA-DETAILS-0353: ALL PASS \\\(35\/35\\\)" psql -q -f tests\/db\/r154h-wa-details-0353\.sql/);
  assert.match(r('supabase/check-prod-overrides.json'), /"0353": \{ "note": "WhatsApp IDs saved without the token/);
  assert.match(r('supabase/CHECK-PROD-MIGRATIONS.sql'), /\('0353_r154h_wa_details', 'marker', 'public', 'save_org_whatsapp_account', 'text,text,text,text\|r154h-0353'\)/);
});

await t('0353: additive - old bodies kept once, no drop / delete / truncate, token only into the old body, grants', () => {
  const c = code(M);
  assert.doesNotMatch(c, /\b(drop|truncate)\b/i);
  assert.doesNotMatch(c, /\bdelete\s+from\b/i);
  assert.match(c, /if to_regprocedure\('public\.save_org_whatsapp_account__pre0353\(text,text,text,text\)'\) is null then\n\s+alter function public\.save_org_whatsapp_account\(text, text, text, text\) rename to save_org_whatsapp_account__pre0353;/);
  assert.match(c, /alter function public\.my_integration_accounts\(\) rename to my_integration_accounts__pre0353;/);
  // with a token the old body runs unchanged; without one only the two IDs are written
  assert.match(c, /if nullif\(btrim\(coalesce\(p_token, ''\)\), ''\) is not null then\n\s+return public\.save_org_whatsapp_account__pre0353\(p_waba_id, p_phone_number_id, p_token, p_display_phone\);/);
  assert.doesNotMatch(c.slice(c.indexOf("raise exception 'not_allowed'")), /token_secret_id\s*=/, 'the IDs-only path never writes the token column');
  assert.doesNotMatch(c, /_integ_vault_get|decrypted_secret/, 'never reads a secret');
  assert.match(c, /'token_saved', w\.token_secret_id is not null/);
  assert.doesNotMatch(c, /'token_secret_id'/, 'the key id itself never leaves the database');
  assert.doesNotMatch(c, /grant [^\n]* to (anon|public)\b/i);
  assert.match(c, /grant execute on function public\.save_org_whatsapp_account\(text, text, text, text\) to authenticated/);
  assert.match(c, /'public\.save_org_whatsapp_account__pre0353\(text, text, text, text\)', 'public\.my_integration_accounts__pre0353\(\)'\] loop/);
  assert.match(c, /STOP 0353: run 0337 \(studio WhatsApp\) first/);
});

await t('APPLY-0353: header, begin + migration verbatim + commit, VERIFY last; editor-safe comments; ASCII', () => {
  assert.match(A, /^-- APPLY-0353 \(R154h [^\n]*\)\. Run on STAGING first, then production\. Safe to run twice\.\n/);
  assert.ok(A.includes('\nbegin;\n' + M.replace(/\s*$/, '\n') + '\ncommit;\n'));
  assert.equal((A.match(/^begin;$/gm) || []).length, 1); assert.equal((A.match(/^commit;$/gm) || []).length, 1);
  assert.match(A, /\ncommit;\n\n-- VERIFY every line should say true\nselect item, ok from \(values\n[\s\S]*\n\) v\(item, ok\) order by item;\n$/);
  assert.equal((A.match(/^  \('0\d /gm) || []).length, 9);
  for (const s of [M, A]) {
    assert.ok(/^[\x09\x0a\x20-\x7e]*$/.test(s), 'ASCII only');
    for (const l of s.split('\n')) {
      const c = l.indexOf('--'); if (c < 0) continue;
      if ((l.slice(0, c).match(/'/g) || []).length % 2) continue;
      assert.doesNotMatch(l.slice(c), /['";]/, 'comment with a quote or semicolon: ' + l);
    }
    assert.doesNotMatch(s, /^\s*\\/m); assert.doesNotMatch(s, /\bcreate\s+(temp|temporary)\s+table\b/i);
    assert.doesNotMatch(s, /^\s*(set|reset)\s+/im);
  }
});

await t('wa-connect: reason codes on every failed check, no token in an answer or a log', () => {
  const s = r('supabase/functions/wa-connect/index.ts');
  assert.match(s, /code: "details_missing"/); assert.match(s, /code: "not_checked"/); assert.match(s, /code: "timeout"/);
  assert.match(s, /if \(!v\.ok\) return json\(\{ ok: false, status: "error", error: v\.error, code: v\.code \|\| "other" \}\);/);
  assert.match(s, /code: ge\.kind === "number" \? "waba" : ge\.kind/);
  assert.doesNotMatch(s, /json\(\{[^\n]*(?:[{,]\s*token\s*[,:}]|:\s*token\b)/, 'no answer carries the token variable');
  assert.doesNotMatch(s, /(log|L)\.(error|info|warn)\([^\n]*token\b(?!s)/i, 'no log line carries the token');
});

await t('page: never stores the token in the browser; versions bumped; guide + tour say Save details / Replace token', () => {
  const ui = r('public/wa-connect-ui.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''), h = r('public/integrations.html');
  assert.doesNotMatch(ui, /localStorage|sessionStorage|indexedDB|document\.cookie|console\.|location\.(hash|search|href)\s*=|history\.(push|replace)State/);
  assert.doesNotMatch(ui, /innerHTML|insertAdjacentHTML|outerHTML/);
  assert.match(h, /wa-connect-ui\.js\?v=3/); assert.match(h, /integrations\.js\?v=10/); assert.match(h, /integrations\.css\?v=9/);
  assert.match(h, /Press <b>Save details<\/b> – the two IDs stay saved/);
  assert.match(r('public/page-tours.js'), /Save details keeps the two IDs without the token/);
  assert.match(r('public/tour.js'), /const PT_V = "31";/);
});

await t('pure helpers: tokenSaved, statusLine, codeHelp, validateIds, isDirty', () => {
  const C = require('../public/wa-connect-ui.js');
  assert.equal(C.tokenSaved(null), false);
  assert.equal(C.tokenSaved({ status: 'pending', token_saved: false }), false);
  assert.equal(C.tokenSaved({ status: 'pending' }), true, 'older server: a pending row always had a token');
  assert.equal(C.tokenSaved({ status: 'disabled' }), false);
  assert.match(C.statusLine({ status: 'pending', waba_id: '1000000353', phone_number_id: '2000000353', token_saved: false }), /^Saved - not connected yet \(reason: the access token is not saved yet\)/);
  assert.match(C.statusLine({ status: 'error', token_saved: true, last_error: 'the access token stopped working - paste a new permanent token and save again' }), /^Saved - not connected yet \(reason: the access token stopped working/);
  assert.equal(C.statusLine({ status: 'connected', display_phone: '+91 90000 00353', verified_name: 'Rao Events', token_saved: true }), 'Connected as +91 90000 00353 (Rao Events).');
  assert.match(C.statusLine({ status: 'disabled', waba_id: '1000000353' }), /Business Account ID is still saved/);
  for (const k of ['token', 'permission', 'number', 'waba', 'not_in_account', 'limit', 'timeout', 'details_missing']) assert.ok(C.codeHelp(k).length > 20, k);
  assert.equal(C.codeHelp('nope'), '');
  assert.equal(C.validateIds({ wabaId: '1000000353', phoneId: '2000000353' }), '');
  assert.match(C.validateIds({ wabaId: '1000000353', phoneId: '2000000353', token: 'short' }), /token/);
  assert.match(C.validateIds({ wabaId: 'x', phoneId: '2000000353' }), /Business Account ID/);
  assert.equal(C.isDirty({ waba_id: '1', phone_number_id: '2' }, { wabaId: '1', phoneId: '2', token: '' }), false);
  assert.equal(C.isDirty({ waba_id: '1', phone_number_id: '2' }, { wabaId: '1', phoneId: '3', token: '' }), true);
  assert.equal(C.isDirty({ waba_id: '1', phone_number_id: '2' }, { wabaId: '1', phoneId: '2', token: 'x' }), true);
  assert.match(C.friendly({ message: 'invalid_phone_number_id' }), /not the phone number/);
});

// ---- a small fake DOM, enough for the card -------------------------------------------------------------------------------
class Node_ {
  constructor(tag) { this.tagName = String(tag || '#text').toUpperCase(); this.children = []; this.parentNode = null; this.attrs = {}; this.listeners = {}; this.hidden = false; this._text = ''; this.value = ''; this.disabled = false; this.open = false; }
  get firstChild() { return this.children[0] || null; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; }
  setAttribute(k, v) { this.attrs[k] = String(v); } getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; } removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
  fire(ev) { for (const fn of this.listeners[ev] || []) fn.call(this, { type: ev, target: this, preventDefault() {} }); }
  click() { if (!this.disabled) this.fire('click'); }
  focus() {}
  set textContent(v) { this.children = []; this._text = String(v); } get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  all() { return [this].concat(...this.children.map((c) => c.all())); }
  byId(id) { return this.all().find((x) => x.id === id) || null; }
  dump() { return this.all().map((x) => [x._text, x.value, Object.values(x.attrs).join(' ')].join(' ')).join('\n'); }
}
const doc = { createElement: (t) => new Node_(t), createTextNode: (s) => { const x = new Node_('#text'); x._text = String(s); return x; } };
const guards = [];
globalThis.BPUI = { trackDirty() { const g = { d: false, mark() { this.d = true; }, clean() { this.d = false; }, isDirty() { return this.d; }, dispose() { this.disposed = true; } }; guards.push(g); return g; },
  confirm: () => Promise.resolve(true) };
const storageTouch = [];
for (const k of ['localStorage', 'sessionStorage']) {
  Object.defineProperty(globalThis, k, { configurable: true, get() { storageTouch.push(k); return { getItem() { return null; }, setItem() {}, removeItem() {} }; } });
}
globalThis.document = doc;
delete require.cache[require.resolve('../public/wa-connect-ui.js')];
const W = require('../public/wa-connect-ui.js');
const settle = () => new Promise((res) => setTimeout(res, 0));
const TOKEN = 'EAAG-fake-test-token-r154h-0123456789abcdef';

function fakeStore() {
  const st = { row: null, calls: [], failToken: null, verify: { ok: false, status: 'error', code: 'token', error: 'the access token stopped working - paste a new permanent token and save again' } };
  const I = {
    mine: async () => ({ is_admin: true, whatsapp: st.row ? { ...st.row } : null }),
    saveWhatsapp: async (a) => {
      st.calls.push({ ...a, p_token: a.p_token ? '<token>' : a.p_token });
      if (a.p_token && st.failToken) throw new Error(st.failToken);
      const tokenSaved = (st.row && st.row.token_saved) || !!a.p_token;
      st.row = { ...(st.row || {}), waba_id: a.p_waba_id, phone_number_id: a.p_phone_number_id, status: 'pending', token_saved: tokenSaved };
      return { ok: true, status: 'pending' };
    },
    waConnect: async () => { if (st.row) { st.row.status = st.verify.ok ? 'connected' : 'error'; st.row.last_error = st.verify.ok ? null : st.verify.error; } return st.verify; },
    waDisconnect: async () => ({ ok: true }),
  };
  return { st, store: { integrations: I } };
}
const type = (box, id, v) => { const i = box.byId(id); i.value = v; i.fire('input'); };

await t('card, first visit: empty IDs + token box, no Check button; Save details keeps the IDs alone and pre-fills them', async () => {
  const { st, store } = fakeStore(); const box = new Node_('div');
  await W.mount(box, { store });
  assert.equal(box.byId('wacCheck'), null);
  assert.equal(box.byId('wacWaba').value, ''); assert.equal(box.byId('wacToken').value, '');
  type(box, 'wacWaba', '1000000353'); type(box, 'wacPhone', '2000000353');
  assert.equal(guards.at(-1).isDirty(), true, 'typed but not saved -> the leave-page guard is on');
  box.byId('wacKeep').click(); await settle(); await settle(); await settle();
  assert.deepEqual(st.calls, [{ p_waba_id: '1000000353', p_phone_number_id: '2000000353', p_token: null, p_display_phone: null }]);
  assert.equal(box.byId('wacWaba').value, '1000000353', 'pre-filled after the save (and on every later visit)');
  assert.equal(box.byId('wacPhone').value, '2000000353');
  assert.match(box.byId('wacStatus').textContent, /^Saved - not connected yet \(reason: the access token is not saved yet\)/);
  assert.equal(guards.at(-1).isDirty(), false, 'after the save the guard is off');
  // a fresh visit: mounted again from the server only
  const box2 = new Node_('div'); await W.mount(box2, { store });
  assert.equal(box2.byId('wacWaba').value, '1000000353'); assert.equal(box2.byId('wacPhone').value, '2000000353');
});

await t('card: Connect saves the IDs, then the token, then checks; a refused token = saved, not connected + what to fix', async () => {
  const { st, store } = fakeStore(); const box = new Node_('div');
  await W.mount(box, { store });
  type(box, 'wacWaba', '1000000353'); type(box, 'wacPhone', '2000000353'); type(box, 'wacToken', TOKEN);
  box.byId('wacSave').click(); for (let i = 0; i < 8; i++) await settle();
  assert.deepEqual(st.calls.map((c) => c.p_token), [null, '<token>'], 'IDs first (kept whatever happens), then the token');
  const msg = box.byId('wacMsg').textContent;
  assert.match(msg, /^Saved - not connected yet \(reason: the access token stopped working/);
  assert.match(msg, /Make a permanent System User token and press Replace token\./);
  assert.ok(box.byId('wacTokenReplace'), 'token saved -> Replace token');
  assert.equal(box.byId('wacToken').value, '', 'the token box is empty again');
  assert.equal(box.byId('wacToken').parentNode.hidden, true);
  assert.ok(!box.dump().includes(TOKEN) && !box.dump().includes(TOKEN.slice(-4)), 'the token (or its end) is nowhere on the page');
  assert.ok(box.byId('wacCheck'), 'a saved token -> Check connection');
  box.byId('wacTokenReplace').click();
  assert.equal(box.byId('wacToken').parentNode.hidden, false);
});

await t('card: the token save is refused -> IDs kept, token NOT saved (said plainly), kept only in the page, guard stays on', async () => {
  const { st, store } = fakeStore(); st.failToken = 'vault_unavailable'; const box = new Node_('div');
  await W.mount(box, { store });
  type(box, 'wacWaba', '1000000353'); type(box, 'wacPhone', '2000000353'); type(box, 'wacToken', TOKEN);
  box.byId('wacSave').click(); for (let i = 0; i < 8; i++) await settle();
  assert.equal(st.row.waba_id, '1000000353'); assert.equal(st.row.token_saved, false);
  assert.match(box.byId('wacMsg').textContent, /Phone number ID saved\. The access token was NOT saved: Secure key storage is not switched on/);
  assert.equal(box.byId('wacToken').value, TOKEN, 'still in the box for a retry (memory only)');
  assert.equal(guards.at(-1).isDirty(), true, 'leaving now would lose the token -> asks first');
});

await t('card: a connected number - changing the IDs asks first; Connected as +91 ... (name)', async () => {
  const { st, store } = fakeStore(); st.verify = { ok: true, status: 'connected', display_phone: '+91 90000 00353', verified_name: 'Rao Events', webhook: true };
  st.row = { waba_id: '1000000353', phone_number_id: '2000000353', status: 'connected', token_saved: true, display_phone: '+91 90000 00353', verified_name: 'Rao Events' };
  let asked = 0; globalThis.BPUI.confirm = () => { asked++; return Promise.resolve(false); };
  const box = new Node_('div'); await W.mount(box, { store });
  assert.equal(box.byId('wacStatus').textContent, 'Connected as +91 90000 00353 (Rao Events).');
  type(box, 'wacPhone', '2000000999'); box.byId('wacKeep').click(); for (let i = 0; i < 4; i++) await settle();
  assert.equal(asked, 1); assert.equal(st.calls.length, 0, 'said no -> nothing saved');
  globalThis.BPUI.confirm = () => Promise.resolve(true);
});

await t('nothing touched browser storage', () => { assert.deepEqual(storageTouch, []); });
console.log(`r154h-wa-details: ${n} passed`);
