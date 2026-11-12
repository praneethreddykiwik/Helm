// r154c-continue-quotes.test.mjs - R154c "Continue quote" (owner, Nov 2026): starting a SECOND quote no longer hides the
// first one's Continue. Root cause: Home asked the server for ONE row (limit 1) and drew only rows[0]; every other
// unfinished quote was folded into a small "N more in progress" link, and a quote left the list as soon as its quotation
// was saved in step 8. Now: Home lists up to 5 open quotes (newest first, client / step reached / last edited, Continue +
// Hide, "See all N"); a quote stays resumable until Confirmed (quotation saved / locked / sent -> step 9); the list comes
// from my_open_quotes (0350) with a fallback to my_unfinished_quotes (0206); view-only roles get Open; Hide never deletes;
// Quotes rows get a Continue button; tours + SQL 0350 pins.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ✓ ' + name); } catch (e) { fail++; console.log('  ✗ ' + name + '\n    ' + (e && e.stack || e)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
const until = async (fn, ms = 3000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) return false; await sleep(10); } await flush(); return true; };

/* ---------- tiny DOM (same as flow-resume-0206.test.mjs) ---------- */
/* ---------- tiny DOM ---------- */
class El {
  constructor(tag, doc) { this.tagName = tag.toUpperCase(); this.ownerDocument = doc; this.childNodes = []; this.parentNode = null; this.attrs = {}; this.ls = {}; this._t = ''; this.hidden = false; this.cls = new Set(); this.style = {}; this.id = ''; this.href = ''; this.type = ''; }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'class') this.cls = new Set(String(v).split(/\s+/).filter(Boolean)); if (k === 'id') this.id = String(v); if (k === 'href') this.href = String(v); if (k === 'hidden') this.hidden = true; }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; } removeAttribute(k) { delete this.attrs[k]; } hasAttribute(k) { return k in this.attrs; }
  set className(v) { this.cls = new Set(String(v).split(/\s+/).filter(Boolean)); } get className() { return [...this.cls].join(' '); }
  get classList() { const s = this.cls; return { add: (c) => s.add(c), remove: (c) => s.delete(c), contains: (c) => s.has(c), toggle: (c, on) => (on ? s.add(c) : s.delete(c)) }; }
  get firstChild() { return this.childNodes[0] || null; }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.childNodes.push(c); return c; }
  insertBefore(c, ref) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; const i = ref ? this.childNodes.indexOf(ref) : -1; if (i < 0) this.childNodes.push(c); else this.childNodes.splice(i, 0, c); return c; }
  removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); c.parentNode = null; return c; }
  set textContent(v) { this.childNodes = []; this._t = String(v); } get textContent() { return this._t + this.childNodes.map((c) => c.textContent).join(''); }
  addEventListener(ev, fn) { (this.ls[ev] = this.ls[ev] || []).push(fn); }
  fire(type, extra) { const e = Object.assign({ type, target: this, preventDefault() {}, stopPropagation() {} }, extra || {}); (this.ls[type] || []).forEach((f) => f(e)); return e; }
  click() { this.fire('click'); }
  focus() { this.ownerDocument.activeElement = this; }
  all() { return this.childNodes.flatMap((c) => [c, ...c.all()]); }
  querySelector(sel) { const c = sel.replace(/^\./, ''); return this.all().find((x) => x.cls.has(c)) || null; }
}
function makeWin(path) {
  const doc = { readyState: 'complete', ls: {}, createElement: (tg) => new El(tg, doc), addEventListener(ev, fn) { (doc.ls[ev] = doc.ls[ev] || []).push(fn); }, removeEventListener(ev, fn) { doc.ls[ev] = (doc.ls[ev] || []).filter((f) => f !== fn); } };
  doc.body = new El('body', doc); doc.documentElement = doc.body;
  doc.getElementById = (id) => [doc.body, ...doc.body.all()].find((x) => x.id === id) || null;
  doc.querySelector = (s) => doc.body.querySelector(s);
  const ls = {}, store = {};
  const win = { document: doc, URLSearchParams, Date, Math, JSON, Promise, Object, Array, Number, String, setTimeout, clearTimeout, isFinite, encodeURIComponent,
    location: { pathname: path || '/dashboard.html', search: '' }, ls,
    addEventListener(ev, fn) { (ls[ev] = ls[ev] || []).push(fn); },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    crypto: { getRandomValues: (a) => a }, adopted: [] };
  win.__helmAdoptCss = (_d, css) => win.adopted.push(css);
  win.globalThis = win; win.window = win;
  return { win, doc, store };
}
const FR_SRC = read('public/flow-resume.js');
function load(env, src) { vm.runInContext(src, vm.createContext(env.win)); }
const R = require('../public/flow-resume.js');
const Q1 = 'a0000000-0000-4000-8000-0000000000d1', Q2 = 'a0000000-0000-4000-8000-0000000000d2', Q3 = 'a0000000-0000-4000-8000-0000000000d3';
const ago = (h) => new Date(Date.now() - h * 3600e3).toISOString();
const row = (o) => Object.assign({ id: Q1, code: 'WED-01', title: 'WED_HYD_300', event_type: 'Wedding', client: { name: 'Asha' }, my_step: 'proposal', my_step_at: ago(3),
  last_step: 'proposal', last_step_at: ago(3), last_by_me: true, steps_done: ['client', 'discovery', 'reqs', 'venue', 'menu'], steps_total: 8, phase: 'building', activity: ago(3) }, o || {});
/* the owner's case: quote one left at Proposal, then quote two started (newer) */
const TWO = () => ({ total: 2, rows: [row({ id: Q2, code: 'BDAY-02', title: 'BDAY_PUNE_50', client: { name: 'Ravi' }, my_step: 'discovery', my_step_at: ago(0.2), activity: ago(0.2), steps_done: ['client'] }), row()], can_edit: true, open: true });
function fakeStore(o) {
  o = o || {}; let mode = 'local'; const calls = { open: [], list: [], dismiss: [], other: [] };
  const fp = { available: () => mode === 'supabase',
    list: async (a) => { calls.list.push(a); return o.list ? o.list(a) : TWO(); },
    mark: async () => ({ ok: true }), dismiss: async (q) => { calls.dismiss.push(q); return { ok: true }; } };
  if (o.open !== false) fp.open = async (a) => { calls.open.push(a); return o.openFn ? o.openFn(a) : TWO(); };
  const S = { calls, mode: () => mode, init: () => (S._r = S._r || new Promise((r) => setTimeout(() => { mode = 'supabase'; r(); }, 10))),
    auth: { enabled: () => mode === 'supabase', user: () => (mode === 'supabase' ? { id: 'u-real' } : null) },
    quotes: new Proxy({}, { get: (_t, k) => (...a) => { calls.other.push(['quotes.' + String(k), a]); return Promise.resolve(null); } }),
    flowProgress: fp };
  return S;
}
function dashEnv(S) {
  const env = makeWin('/dashboard.html'); env.win.BPStore = S;
  const block = new El('section', env.doc); block.id = 'hdResume'; block.hidden = true; block.setAttribute('data-block', 'resume');
  const body = new El('div', env.doc); body.className = 'hd-body'; body.appendChild(new El('div', env.doc)); block.appendChild(body); env.doc.body.appendChild(block);
  const toasts = []; env.win.BPUI = { toast: (m, o2) => toasts.push([m, o2]) };
  load(env, FR_SRC); return { env, block, toasts };
}
const rowsOf = (host) => host.all().filter((n) => n.cls.has('fr-hrow'));

await t('ROOT CAUSE fixed: start quote one (left at Proposal), start quote two -> Home lists BOTH, newest first, each at its own step', async () => {
  const S = fakeStore(); const { env, block } = dashEnv(S);
  env.win.HelmFlowResume.mount(); await until(() => !block.hidden);
  assert.deepEqual(JSON.parse(JSON.stringify(S.calls.open[0])), { scope: 'mine', limit: 5, maxDays: 60 }, 'Home asks for 5 (was limit 1)');
  const rs = rowsOf(block); assert.equal(rs.length, 2, 'both quotes have a Continue entry');
  assert.deepEqual(rs.map((r) => r.getAttribute('data-quote')), [Q2, Q1], 'most recent first');
  const go = (r) => r.all().find((n) => n.tagName === 'A' && n.textContent === 'Continue');
  assert.equal(go(rs[0]).href, 'flow.html?quote=' + Q2 + '#sec-discovery');
  assert.equal(go(rs[1]).href, 'flow.html?quote=' + Q1 + '#sec-proposal', 'the first quote still goes back to Proposal');
  assert.match(rs[1].textContent, /WED_HYD_300/); assert.match(rs[1].textContent, /Asha · Reached step 6 of 8 · Proposal · edited 3 h ago/);
  assert.match(rs[0].textContent, /Ravi · Reached step 2 of 8 · Discovery · edited (12 min ago|just now)/);
  assert.ok(go(rs[0]).cls.has('hd-primary'), 'dashboard button style');
  assert.match(block.textContent, /2 quotes in progress/); assert.equal(block.all().find((n) => n.cls.has('fr-more')).href, 'quotes.html?view=inprogress');
});

await t('more than 5: shows 5 + "See all N →"', async () => {
  const many = Array.from({ length: 5 }, (_, i) => row({ id: 'a0000000-0000-4000-8000-0000000001' + String(i).padStart(2, '0'), title: 'Q' + i }));
  const S = fakeStore({ openFn: () => ({ total: 9, rows: many, can_edit: true, open: true }) }); const { env, block } = dashEnv(S);
  env.win.HelmFlowResume.mount(); await until(() => !block.hidden);
  assert.equal(rowsOf(block).length, 5); assert.match(block.textContent, /9 quotes in progress/); assert.match(block.textContent, /See all 9 →/);
});

await t('Hide: hides ONLY that quote (dismiss), the others stay, nothing is deleted, a toast says so', async () => {
  const S = fakeStore(); const { env, block, toasts } = dashEnv(S);
  env.win.HelmFlowResume.mount(); await until(() => !block.hidden);
  let rs = rowsOf(block); const hide = rs[1].all().find((n) => n.tagName === 'BUTTON' && n.textContent === 'Hide');
  assert.match(hide.getAttribute('aria-label'), /not deleted/);
  S.flowProgress.open = async (a) => { S.calls.open.push(a); return { total: 1, rows: [TWO().rows[0]], can_edit: true, open: true }; };
  hide.click(); await until(() => S.calls.dismiss.length > 0);
  assert.deepEqual(S.calls.dismiss, [Q1], 'only the hidden quote');
  rs = rowsOf(block); assert.deepEqual(rs.map((r) => r.getAttribute('data-quote')), [Q2], 'the other quote stays');
  assert.equal(block.hidden, false);
  assert.match(toasts[0][0], /not deleted/); assert.deepEqual(S.calls.other, [], 'no quote write / delete call at all');
  await until(() => S.calls.open.length > 1); assert.equal(rowsOf(block).length, 1, 're-read after hide');
  // hiding the last one hides the block
  S.flowProgress.open = async (x) => { S.calls.open.push(x); return { total: 0, rows: [], can_edit: true, open: true }; };
  rowsOf(block)[0].all().find((n) => n.textContent === 'Hide').click();
  await until(() => block.hidden); assert.equal(block.hidden, true);
});

await t('role access: view-only (can_edit false) gets Open to the event, never a Continue into the flow', async () => {
  const S = fakeStore({ openFn: () => Object.assign(TWO(), { can_edit: false }) }); const { env, block } = dashEnv(S);
  env.win.HelmFlowResume.mount(); await until(() => !block.hidden);
  assert.ok(!block.all().some((n) => n.tagName === 'A' && n.textContent === 'Continue'));
  const op = block.all().filter((n) => n.tagName === 'A' && n.textContent === 'Open'); assert.equal(op.length, 2); assert.equal(op[0].href, 'event.html?id=' + Q2);
});

await t('database without 0350: falls back to the 0206 list; offline: nothing, no error', async () => {
  const S = fakeStore({ open: false }); const { env, block } = dashEnv(S);
  env.win.HelmFlowResume.mount(); await until(() => !block.hidden);
  assert.equal(S.calls.list.length, 1); assert.equal(rowsOf(block).length, 2);
  const S2 = fakeStore({ openFn: () => { throw new Error('offline'); } }); const d2 = dashEnv(S2);
  d2.env.win.HelmFlowResume.mount(); await until(() => S2.calls.open.length > 0); await sleep(30); await flush();
  assert.equal(d2.block.hidden, true);
});

await t('past step 8 (0350 phases): quotation saved / locked / sent -> Continue lands on step 9 Share & approval', () => {
  for (const [ph, txt] of [['quoted', 'Quotation saved · not shared yet'], ['locked', 'Locked · not sent yet'], ['sent', 'Sent · waiting for the client']]) {
    const v = R.fromServer(row({ phase: ph, my_step: 'quote' }), true);
    assert.equal(v.step, 'approve', ph); assert.equal(R.href(v), 'flow.html?quote=' + Q1 + '#sec-approve');
    assert.equal(R.stepText(v), 'step 9 · Share with client & approval'); assert.equal(v.phaseLabel, txt);
  }
  const b = R.fromServer(row(), true); assert.equal(b.phase, 'building'); assert.equal(b.phaseLabel, ''); assert.equal(b.step, 'proposal');
  assert.equal(R.fromServer(row({ phase: 'weird' }), true).phase, 'building', 'unknown phase = building');
  assert.equal(R.STEPS.approve, undefined, 'step 9 is a landing only - the flow never saves it (0206 check constraint)');
  assert.equal(R.fromServer(row({ hidden: true }), false).hidden, true);
  assert.equal(R.fromServer(row({ my_step: 'menu', last_step: 'layout' }), false).myStep, 'menu');
  const env = makeWin('/dashboard.html'); load(env, FR_SRC); const host = new El('div', env.doc);
  env.win.HelmFlowResume.renderHome(host, { rows: [R.fromServer(row({ phase: 'sent' }), true)], total: 1, canEdit: true });
  assert.match(host.textContent, /Reached step 9 · Share with client & approval/); assert.match(host.textContent, /Sent · waiting for the client/);
});

await t('isOpen / phaseOf (Quotes rows): open until Confirmed', () => {
  const o = (x) => R.isOpen(Object.assign({ status: 'quote', approvalStatus: 'none', lifecycleStage: 'quote' }, x));
  assert.equal(o({}), true); assert.equal(o({ lifecycleStage: 'proposal' }), true); assert.equal(o({ status: 'confirmed' }), true, 'locked, not sent');
  assert.equal(o({ approvalStatus: 'sent' }), true, 'sent, waiting');
  for (const x of [{ approvalStatus: 'approved' }, { approvalStatus: 'paid' }, { status: 'cancelled' }, { lifecycleStage: 'confirmed' }, { lifecycleStage: 'planning' },
    { archivedAt: '2026-11-01' }, { deletedAt: '2026-11-01' }, { isDemo: true }]) assert.equal(o(x), false, JSON.stringify(x));
  assert.equal(R.isOpen(null), false);
  assert.equal(R.phaseOf({ approvalStatus: 'sent' }), 'sent'); assert.equal(R.phaseOf({ status: 'confirmed' }), 'locked'); assert.equal(R.phaseOf({}), 'building');
});

await t('In progress list (Quotes tab): phase pill, "Next:" past step 8, hidden note, open-wording when empty', () => {
  const env = makeWin('/quotes.html'); load(env, FR_SRC); const H = env.win.HelmFlowResume; const host = new El('div', env.doc);
  H.renderList(host, { rows: [H.fromServer(row({ phase: 'quoted', hidden: true }), false)], total: 1, canEdit: true, open: true });
  assert.match(host.textContent, /Quotation saved · not shared yet/); assert.match(host.textContent, /Next: Share with client & approval/); assert.match(host.textContent, /Hidden from your Home list/);
  assert.ok(host.all().some((n) => n.tagName === 'A' && n.textContent === 'Continue' && n.href.endsWith('#sec-approve')));
  H.renderList(host, { rows: [], open: true }); assert.match(host.textContent, /Every quote shows here until it is confirmed/);
  H.renderList(host, { rows: [] }); assert.match(host.textContent, /until their quotation is saved in step 8/, 'pre-0350 wording kept');
});

await t('store-api: flowProgress.open() -> my_open_quotes, falls back to list() once when 0350 is missing; it is a cached read', () => {
  const s = read('public/store-api.js');
  assert.match(s, /async open\(opts\) \{/);
  assert.match(s, /const d = await rpc\("my_open_quotes", args\); return d && typeof d === "object" && Array\.isArray\(d\.rows\) \? d : null;/);
  assert.match(s, /if \(!rpcMissing\(e\)\) throw e;\n\s*flowProgress\._noOpen = true;/);
  assert.match(s, /\|my_unfinished_quotes\|my_open_quotes\)\(\\\?\|\$\)\/;/);
});

await t('Quotes page: an open row leads with "▶ Continue" (editors only), safe link guard, one read feeds tab count + buttons', () => {
  const q = read('public/quotes.html');
  assert.ok(q.includes('if(cont&&ra0){ const cb=document.createElement("button"); cb.type="button"; cb.className="ic confirm"; cb.setAttribute("data-act","continue");'), 'Continue built as DOM (no HTML sink)');
  assert.ok(q.includes('cb.textContent="▶ Continue"; ra0.insertBefore(cb, ra0.firstChild); }'), 'first in the row, text only');
  assert.match(q, /if\(!canEdit \|\| ip\.canEdit===false \|\| !H \|\| sh\(x\) \|\| !H\.isOpen\(x\)\) return null;/, 'view-only roles / read-only studio / shelved: no Continue');
  assert.ok(q.includes('if(act==="continue"){ const h=b.getAttribute("data-href")||""; if(/^flow\\.html\\?quote=[0-9a-f-]{36}(#sec-[a-z]+)?$/i.test(h)) location.href=h; }'), 'only a flow.html?quote=<uuid>#sec-step link is followed');
  assert.match(q, /d=await HelmFlowResume\.load\(BPStore, ipUid\(\), \{ scope:"studio", limit:100 \}\); \}catch\(_\)\{ d=null; \}\n\s*if\(d && d\.source==="server"\)/);
  // Continue is inserted first, before the 4th+ actions fold into the ⋯ menu, so it stays visible
  const i = q.indexOf('cb.textContent="▶ Continue"'), j = q.indexOf('const ra=tr.querySelector(".row-actions"), acts='); assert.ok(i > 0 && i < j, 'added before the ⋯ split');
});

await t('tours: Home tour has the Continue quotes step, Quotes tour has In progress + Continue wording', () => {
  const d = read('public/dashboard.html'), p = read('public/page-tours.js');
  assert.match(d, /\{sel:'#hdResume', need:"quotes", uses:"edit:quotes",[^\n]*title:"Continue quotes"/);
  assert.match(p, /\{ sel: "#tab_inprogress", title: "In progress",/);
  assert.match(p, /has a Continue button that takes you back to the step you left/);
  assert.match(read('public/shell-b-dash.js'), /card\("hdResume", "Continue quotes", IC\.doc/);
});

await t('SQL 0350: one new read-only function, additive, editor-safe paste file, MANIFEST + run-all + prod checker', () => {
  const m = read('supabase/migrations/0350_r154c_open_quotes.sql'), a = read('supabase/APPLY-0350.sql');
  for (const f of [m, a]) assert.ok(!/[^\x00-\x7f]/.test(f), 'ASCII only');
  const code = m.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
  assert.doesNotMatch(code, /\b(update|delete from|insert into|truncate|drop|alter table)\b/i, 'never writes / drops anything');
  assert.match(m, /create or replace function public\.my_open_quotes\(p_scope text default 'mine'/);
  assert.match(m, /returns jsonb language plpgsql stable security definer set search_path = '' as \$\$/);
  assert.match(m, /where q\.org_id = v_org/, 'own studio only');
  assert.match(m, /not coalesce\(public\.has_area\('quotes', 'view'\), false\)/); assert.match(m, /v_edit := coalesce\(public\.has_area\('quotes', 'edit'\), false\);/);
  assert.match(m, /and coalesce\(q\.approval_status, 'none'\) in \('none', 'sent'\)/); assert.match(m, /and coalesce\(q\.status, 'quote'\) in \('quote', 'confirmed'\)/);
  assert.match(m, /and coalesce\(q\.lifecycle_stage, 'quote'\) in \('lead', 'discovery', 'proposal', 'quote'\)/);
  assert.match(m, /revoke all on function public\.my_open_quotes\(text, int, int, uuid, int\) from anon/);
  // editor-safe: comments carry no apostrophe, double quote or semicolon (Supabase SQL editor splits on them)
  for (const f of [m, a]) for (const l of f.split('\n').filter((x) => /^\s*--/.test(x))) assert.doesNotMatch(l, /['";]/, l);
  assert.match(a, /^-- APPLY-0350 /); assert.match(a, /\nbegin;\n/); assert.match(a, /notify pgrst, 'reload schema';\ncommit;\n/); assert.match(a, /-- VERIFY every line should say true\nselect item, ok from \(values/);
  assert.ok(a.includes(m.replace(/\s*$/, '')), 'APPLY carries the migration verbatim');
  assert.doesNotMatch(a, /^\\|create temp/im, 'no psql meta command / temp table');
  assert.match(read('supabase/migrations/MANIFEST'), /\nforward  supabase\/migrations\/0350_r154c_open_quotes\.sql\n/);
  assert.match(read('scripts/db-test/run-all.sh'), /run "r154c-open-quotes-0350" "R154C-OPEN-QUOTES-0350: ALL PASS \\\(21\/21\\\)" psql -q -f tests\/db\/r154c-open-quotes-0350\.sql/);
  assert.match(read('supabase/CHECK-PROD-MIGRATIONS.sql'), /\('0350_r154c_open_quotes', 'fn', 'public', 'my_open_quotes', 'text,integer,integer,uuid,integer'\)/);
});

await t('cache busters: every page loads the same new flow-resume.js / store-api.js version', () => {
  const pages = ['dashboard', 'quotes', 'event', 'flow'].map((p) => read('public/' + p + '.html'));
  const fv = new Set(pages.flatMap((h) => [...h.matchAll(/flow-resume\.js\?v=(\d+)/g)].map((x) => x[1])));
  assert.equal(fv.size, 1); assert.ok(+[...fv][0] > 6, 'flow-resume.js bumped past v6');
  const sv = new Set(pages.flatMap((h) => [...h.matchAll(/store-api\.js\?v=(\d+)/g)].map((x) => x[1]))); assert.equal(sv.size, 1); assert.ok(+[...sv][0] > 344);
});

console.log(`r154c-continue-quotes: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
