// r161-continue-banner.test.mjs - R161 (owner, Nov 2026): ONE "Continue where you left off" banner wherever a quote that is not
// yet Confirmed is opened (event workspace, quote flow, Discovery, Proposal, the Quotes Confirm dialog), never for Confirmed /
// later, cancelled, archived, deleted or sample quotes, never for a view-only role, "Not now" = hidden for this tab session;
// clear copy ("Next: Quotation (step 8 of 8) · Discovery and Proposal skipped"); the Continue lists newest activity first
// (0356 + sortRows), and a quote opened in the flow joins the list at once (earlyLand). Behaviour of the SQL:
// tests/db/r161-open-quotes-order-0356.sql. Real pages: tests/e2e/workflow/continue-banner.spec.mjs.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ✓ ' + name); } catch (e) { fail++; console.log('  ✗ ' + name + '\n    ' + (e && e.stack || e)); } };
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };

/* ---------- tiny DOM (same shape as r154c-continue-quotes.test.mjs) ---------- */
class El {
  constructor(tag, doc) { this.tagName = tag.toUpperCase(); this.ownerDocument = doc; this.childNodes = []; this.parentNode = null; this.attrs = {}; this.ls = {}; this._t = ''; this.hidden = false; this.cls = new Set(); this.style = {}; this.id = ''; this.href = ''; this.type = ''; }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; } removeAttribute(k) { delete this.attrs[k]; } hasAttribute(k) { return k in this.attrs; }
  set className(v) { this.cls = new Set(String(v).split(/\s+/).filter(Boolean)); } get className() { return [...this.cls].join(' '); }
  get firstChild() { return this.childNodes[0] || null; }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.childNodes.push(c); return c; }
  insertBefore(c, ref) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; const i = ref ? this.childNodes.indexOf(ref) : -1; if (i < 0) this.childNodes.push(c); else this.childNodes.splice(i, 0, c); return c; }
  removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); c.parentNode = null; return c; }
  set textContent(v) { this.childNodes = []; this._t = String(v); } get textContent() { return this._t + this.childNodes.map((c) => c.textContent).join(''); }
  addEventListener(ev, fn) { (this.ls[ev] = this.ls[ev] || []).push(fn); }
  click() { const e = { type: 'click', target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } }; (this.ls.click || []).forEach((f) => f(e)); return e; }
  all() { return this.childNodes.flatMap((c) => [c, ...c.all()]); }
}
function makeWin(opts) {
  opts = opts || {};
  const doc = { readyState: 'complete', createElement: (tg) => new El(tg, doc), addEventListener() {} };
  doc.body = new El('body', doc); doc.documentElement = doc.body;
  doc.getElementById = (id) => doc.body.all().find((x) => x.id === id) || null;
  const ss = {};
  const sessionStorage = opts.ssThrows ? { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } }
    : { getItem: (k) => (k in ss ? ss[k] : null), setItem: (k, v) => { ss[k] = String(v); }, removeItem: (k) => { delete ss[k]; } };
  const win = { document: doc, URLSearchParams, Date, Math, JSON, Promise, Object, Array, Number, String, setTimeout, clearTimeout, isFinite, encodeURIComponent,
    location: { pathname: '/event.html', search: '' }, addEventListener() {}, sessionStorage,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, adopted: [] };
  win.__helmAdoptCss = (_d, css) => win.adopted.push(css);
  win.globalThis = win; win.window = win;
  return { win, doc, ss };
}
const FR_SRC = read('public/flow-resume.js');
const R = require('../public/flow-resume.js');
const Q1 = 'a0000000-0000-4000-8000-0000000000e1', Q2 = 'a0000000-0000-4000-8000-0000000000e2', Q3 = 'a0000000-0000-4000-8000-0000000000e3';
const ago = (h) => new Date(Date.now() - h * 3600e3).toISOString();
const row = (o) => Object.assign({ id: Q1, code: 'WED-01', title: 'WED_HYD_300', client: { name: 'Asha' }, my_step: 'venue', my_step_at: ago(2), last_step: 'venue', last_step_at: ago(2),
  last_by_me: true, steps_done: ['client', 'discovery', 'reqs'], steps_total: 8, phase: 'building', activity: ago(2), updated_at: ago(3), created_at: ago(30) }, o || {});
const OPEN = { id: Q1, status: 'quote', lifecycleStage: 'quote', approvalStatus: 'none' };
function fakeStore(o) {
  o = o || {}; const calls = { open: [], canEdit: 0 };
  return { calls, auth: { enabled: () => true, user: () => ({ id: 'u1' }), canEditArea: async (a) => { calls.canEdit++; assert.equal(a, 'quotes'); return o.canEditArea !== false; } },
    quotes: {}, flowProgress: { available: () => o.available !== false, list: async () => ({ rows: [] }),
      open: async (a) => { calls.open.push(a); if (o.throws) throw new Error('offline'); return o.answer ? o.answer(a) : { total: 1, rows: [row(o.row)], can_edit: o.serverEdit !== false, open: true }; } } };
}
function page(opts) {
  const env = makeWin(opts); vm.runInContext(FR_SRC, vm.createContext(env.win));
  const app = new El('div', env.doc), head = new El('div', env.doc); head.id = 'evHead'; app.appendChild(new El('div', env.doc)); app.appendChild(head); env.doc.body.appendChild(app);
  return { env, H: env.win.HelmFlowResume, app, head };
}
const banner = (env) => env.doc.getElementById('flowResumeBanner');

await t('copy: the owner case "step 8 of 8 (Quotation). 2 of 8 steps done" is now "Next: Quotation (step 8 of 8) · Discovery and Proposal skipped"', () => {
  const v = R.fromServer(row({ my_step: 'quote', steps_done: ['client', 'reqs', 'venue', 'menu', 'layout'] }), true);
  assert.deepEqual(R.skippedOf(v), ['Discovery', 'Proposal']);
  assert.deepEqual(R.bannerText(v), { next: 'Next: Quotation (step 8 of 8)', note: 'Discovery and Proposal skipped' });
  const v3 = R.fromServer(row({ my_step: 'quote', steps_done: ['client', 'layout'] }), true);
  assert.equal(R.bannerText(v3).note, 'Discovery, Requirements, Venue, Menu and Proposal skipped');
  const v1 = R.fromServer(row({ my_step: 'menu', steps_done: ['client', 'discovery', 'reqs'] }), true);
  assert.equal(R.bannerText(v1).note, 'Venue skipped');
  const v0 = R.fromServer(row(), true);
  assert.deepEqual(R.bannerText(v0), { next: 'Next: Venue (step 4 of 8)', note: '3 of 8 steps done' }, 'nothing skipped: progress');
  assert.equal(R.bannerText(R.fromServer(row({ my_step: 'client', steps_done: [] }), true)).note, '', 'a brand-new quote: no note');
  const q = R.fromServer(row({ phase: 'quoted', steps_done: ['client', 'discovery', 'reqs', 'venue', 'menu', 'proposal', 'layout', 'quote'] }), true);
  assert.deepEqual(R.bannerText(q), { next: 'Next: Share with client & approval (step 9)', note: '' });
  assert.equal(R.bannerText(R.fromServer(row({ phase: 'sent', steps_done: ['client', 'quote'] }), true)).note, 'Discovery, Requirements, Venue, Menu, Proposal and Layout skipped');
});

await t('banner: shown for an open quote, above the event header, Continue goes to the exact step, phase pill, last worked by', async () => {
  const { env, H, app, head } = page(); const S = fakeStore({ row: { my_step: null, last_step: 'quote', last_by_me: false, last_user_name: 'Priya', last_step_at: ago(0.17), steps_done: ['client', 'reqs', 'venue', 'menu', 'layout'] } });
  const b = await H.mountBanner({ host: app, before: head, quote: OPEN, store: S });
  assert.ok(b && banner(env) === b); assert.equal(app.childNodes.indexOf(b), app.childNodes.indexOf(head) - 1);
  assert.deepEqual(JSON.parse(JSON.stringify(S.calls.open[0])), { scope: 'studio', quote: Q1, limit: 1 }, 'one quote, the open list (0350/0356)');
  assert.match(b.textContent, /^Not confirmed yetNext: Quotation \(step 8 of 8\) · Discovery and Proposal skipped/);
  assert.match(b.textContent, /Last worked on by Priya, 10 min ago/);
  const go = b.all().find((n) => n.tagName === 'A'); assert.equal(go.textContent, 'Continue where you left off'); assert.equal(go.href, 'flow.html?quote=' + Q1 + '#sec-quote');
  assert.equal(S.calls.canEdit, 1, 'asked the store: quotes edit');
  const S2 = fakeStore({ row: { phase: 'sent' } }); const b2 = await H.mountBanner({ host: app, quote: Object.assign({}, OPEN, { approvalStatus: 'sent' }), store: S2, canEdit: true });
  assert.match(b2.textContent, /Next: Share with client & approval \(step 9\)/); assert.match(b2.textContent, /Sent · waiting for the client/);
  assert.equal(b2.all().find((n) => n.tagName === 'A').href, 'flow.html?quote=' + Q1 + '#sec-approve');
  assert.equal(env.doc.body.all().filter((n) => n.id === 'flowResumeBanner').length, 1, 'one banner at a time');
});

await t('never for Confirmed / later, cancelled, archived, deleted, auto-discarded, approved, paid or sample quotes (no server call)', async () => {
  for (const x of [{ lifecycleStage: 'confirmed' }, { lifecycleStage: 'planning' }, { lifecycleStage: 'closed' }, { status: 'cancelled' }, { approvalStatus: 'approved' },
    { approvalStatus: 'paid' }, { archivedAt: '2026-11-01' }, { deletedAt: '2026-11-01' }, { autoDiscardedAt: '2026-11-01' }, { isDemo: true }]) {
    const { env, H, app } = page(); const S = fakeStore();
    assert.equal(await H.mountBanner({ host: app, quote: Object.assign({}, OPEN, x), store: S, canEdit: true }), null, JSON.stringify(x));
    assert.equal(banner(env), null); assert.equal(S.calls.open.length, 0, 'no read for ' + JSON.stringify(x));
  }
  // the server is the final word: not in the open list (e.g. confirmed elsewhere a moment ago) -> no banner, an old one is removed
  const { env, H, app } = page(); await H.mountBanner({ host: app, quote: OPEN, store: fakeStore(), canEdit: true }); assert.ok(banner(env));
  assert.equal(await H.mountBanner({ host: app, quote: OPEN, store: fakeStore({ answer: () => ({ total: 0, rows: [], can_edit: true }) }), canEdit: true }), null);
  assert.equal(banner(env), null, 'stale banner removed');
  assert.equal(await H.mountBanner({ host: app, quote: OPEN, store: fakeStore({ answer: () => ({ total: 1, rows: [row({ id: Q2 })], can_edit: true }) }), canEdit: true }), null, 'a row for another quote is ignored');
});

await t('view-only roles: no banner (page says canEdit false, the store says no quotes edit, or the server says can_edit false / read-only studio)', async () => {
  for (const [o, mo] of [[{}, { canEdit: false }], [{ canEditArea: false }, {}], [{ serverEdit: false }, { canEdit: true }]]) {
    const { env, H, app } = page(); const S = fakeStore(o);
    assert.equal(await H.mountBanner(Object.assign({ host: app, quote: OPEN, store: S }, mo)), null, JSON.stringify([o, mo])); assert.equal(banner(env), null);
  }
  const { app } = page(); assert.equal(R.renderBanner(app, R.fromServer(row(), true), { canEdit: false }), null, 'renderBanner itself refuses a view-only role');
});

await t('"Not now" hides it for this session only (sessionStorage, quote ids only); other quotes still show; blocked storage never breaks the page', async () => {
  const { env, H, app } = page(); const S = fakeStore();
  const b = await H.mountBanner({ host: app, quote: OPEN, store: S, canEdit: true });
  const x = b.all().find((n) => n.tagName === 'BUTTON'); assert.equal(x.textContent, 'Not now'); assert.match(x.getAttribute('aria-label'), /for this session \(the quote is not changed\)/);
  x.click(); assert.equal(banner(env), null);
  assert.deepEqual(JSON.parse(env.ss[H.HIDE_KEY]), [Q1], 'only the quote id is kept');
  assert.equal(await H.mountBanner({ host: app, quote: OPEN, store: S, canEdit: true }), null, 'stays hidden on the next open');
  assert.equal(S.calls.open.length, 1, 'no read while hidden');
  assert.ok(await H.mountBanner({ host: app, quote: Object.assign({}, OPEN, { id: Q2 }), store: fakeStore({ row: { id: Q2 } }), canEdit: true }), 'another quote still shows');
  env.ss[H.HIDE_KEY] = '{oops'; assert.equal(H.bannerHidden(Q1), false, 'a broken value is ignored');
  const p2 = page({ ssThrows: true }); const b3 = await p2.H.mountBanner({ host: p2.app, quote: OPEN, store: fakeStore(), canEdit: true });
  assert.ok(b3, 'storage blocked: still shows'); b3.all().find((n) => n.tagName === 'BUTTON').click(); assert.equal(banner(p2.env), null, 'and Not now still closes it');
  assert.equal(R.hideBanner('not-a-uuid'), false);
});

await t('flow page: no banner when it already shows that step; onContinue keeps the user on the page; a newer mount wins; offline = nothing', async () => {
  const { env, H, app } = page();
  assert.equal(await H.mountBanner({ host: app, quote: OPEN, store: fakeStore(), canEdit: true, current: 'venue' }), null, 'already on Venue');
  let got = null; const b = await H.mountBanner({ host: app, quote: OPEN, store: fakeStore(), canEdit: true, current: 'client', onContinue: (v) => { got = v.step; } });
  const e = b.all().find((n) => n.tagName === 'A').click(); assert.equal(got, 'venue'); assert.equal(e.defaultPrevented, true);
  let release; const slow = fakeStore({ answer: () => new Promise((r) => { release = () => r({ total: 1, rows: [row()], can_edit: true }); }) });
  const pA = H.mountBanner({ host: app, quote: OPEN, store: slow, canEdit: true });
  const pB = H.mountBanner({ host: app, quote: Object.assign({}, OPEN, { id: Q3 }), store: fakeStore({ row: { id: Q3 } }), canEdit: true });
  await flush(); release(); assert.equal(await pA, null, 'the older ask is dropped'); assert.equal((await pB).getAttribute('data-quote'), Q3);
  const off = page(); assert.equal(await off.H.mountBanner({ host: off.app, quote: OPEN, store: fakeStore({ throws: true }), canEdit: true }), null);
  assert.equal(await off.H.mountBanner({ host: off.app, quote: OPEN, store: fakeStore({ available: false }), canEdit: true }), null, 'local mode / signed out');
  assert.equal(await off.H.mountBanner({ host: off.app, quoteId: 'SMP-1003', store: fakeStore(), canEdit: true }), null, 'not a quote id');
});

await t('ordering: newest activity first, ties by created time; a teammate step counts; load() orders the server rows', async () => {
  const a = R.fromServer(row({ id: Q1, activity: ago(5), my_step_at: ago(5), last_step_at: ago(0.1), updated_at: ago(6), last_by_me: false }), true);
  assert.equal(a.activity, a.lastAt, 'mine: the quote last activity includes a teammate step'); assert.ok(Date.now() - Date.parse(a.at) < 3600e3, 'edited 6 min ago, not 5 h');
  const s = R.sortRows([{ quoteId: 'old', activity: ago(9), created: ago(20) }, { quoteId: 'tieOld', activity: ago(1), created: ago(30) }, { quoteId: 'tieNew', activity: ago(1), created: ago(10) }, { quoteId: 'new', activity: ago(0.01), created: ago(0.01) }]);
  assert.deepEqual(s.map((v) => v.quoteId), ['new', 'tieNew', 'tieOld', 'old']);
  const same = ago(2); assert.deepEqual(R.sortRows([{ quoteId: 'x', activity: same }, { quoteId: 'y', activity: same }]).map((v) => v.quoteId), ['x', 'y'], 'full tie: server order kept');
  const S = { auth: {}, quotes: {}, flowProgress: { available: () => true, open: async () => ({ total: 3, can_edit: true, open: true, rows: [
    row({ id: Q1, activity: ago(4), my_step_at: ago(4), last_step_at: ago(4), updated_at: ago(4) }),
    row({ id: Q2, activity: ago(5), my_step_at: ago(5), last_step_at: ago(0.05), updated_at: ago(5) }),     // a pre-0356 server: teammate step not in activity
    row({ id: Q3, activity: ago(3), my_step_at: ago(3), last_step_at: ago(3), updated_at: ago(3) })] }) } };
  const d = await R.load(S, 'u1', { scope: 'mine', limit: 5 });
  assert.deepEqual(d.rows.map((v) => v.quoteId), [Q2, Q3, Q1]);
});

await t('pages: every quote entry point mounts the shared banner; the flow saves its opening step before the long load', () => {
  const e = read('public/event.html'), f = read('public/flow.html'), di = read('public/discovery.html'), pr = read('public/proposal.html'), q = read('public/quotes.html');
  assert.match(e, /HelmFlowResume\.mountBanner\(\{ host:\$\("#app"\), before:\$\("#evHead"\), quote:ev, quoteId:ev\.id\|\|id, canEdit, store:BPStore \}\)/);
  assert.doesNotMatch(e, /HelmFlowResume\.renderBanner\(/, 'the old one-off banner code is gone');
  assert.match(di, /HelmFlowResume\.mountBanner\(\{ host:\$\("#app"\), quote:ev, quoteId:ev\.id\|\|id, current:"discovery", store:BPStore \}\)/);
  assert.match(pr, /HelmFlowResume\.mountBanner\(\{ host:\$\("#app"\), quote:ev, quoteId:ev\.id\|\|id, current:"proposal", store:BPStore \}\)/);
  for (const h of [di, pr]) assert.match(h, /<script src="flow-resume\.js\?v=8"><\/script>/);
  assert.match(q, /HelmFlowResume\.mountBanner\(\{ host:sh, before:sh\.querySelector\("\.seclabel"\), quote:full, quoteId:id, canEdit:canEdit\|\|false, store:BPStore,/);
  assert.match(q, /onContinue:async\(v\)=>\{ if\(!\(await BPUI\.confirmDiscard\(cmDirty\)\)\) return; location\.href=HelmFlowResume\.href\(v\); \}/, 'Confirm dialog: leaving asks first when edited');
  assert.match(f, /const banner=resumeP\.then\(info=>flowBanner\(fromB, info\)\)\.catch\(\(\)=>null\);/, 'flow: the banner is asked for before this open saves its step');
  assert.match(f, /banner\.then\(\(\)=>\{\n\s*if\(resumeLanded \|\| flowTrack\.last\(\)\) return;\n\s*if\(H\.STEPS\[h\]\)\{ flowTrack\.land\(h\)/);
  assert.match(f, /H\.mountBanner\(\{ host, before:host===\$\("#app"\) \? \(\$\("#reminder"\)\|\|null\) : null, quote:ev, quoteId:id, canEdit:true, current:shown, store:BPStore,/);
  assert.match(f, /if\(!H \|\| !ev \|\| !canEdit\) return Promise\.resolve\(null\);/, 'flow: editors only');
  assert.match(f, /loading=true;\n\s*earlyLand\(\);\n\s*await loadAll\(\);/, 'the opening step is saved before loadAll');
  assert.match(f, /resumeP\.then\(info=>\{ if\(resumeLanded \|\| flowTrack\.last\(\)\) return; flowTrack\.land\(info && H\.STEPS\[info\.step\] \? info\.step : "client"\)/);
  for (const p of ['dashboard', 'quotes', 'event', 'flow', 'discovery', 'proposal']) assert.match(read('public/' + p + '.html'), /flow-resume\.js\?v=8/, p);
  assert.match(FR_SRC, /mountBanner: mountBanner, bannerText: bannerText, skippedOf: skippedOf, sortRows: sortRows/);
  assert.match(FR_SRC, /rows: sortRows\(d\.rows\.map\(function \(r\) \{ return fromServer\(r, mine\); \}\)\)/);
  assert.match(FR_SRC, /function sstore\(\) \{ try \{ return root\.sessionStorage \|\| null; \} catch \(e\) \{ return null; \} \}/);
  // the banner is built with textContent only (no HTML sink)
  const rb = FR_SRC.slice(FR_SRC.indexOf('function renderBanner('), FR_SRC.indexOf('function mountBanner('));
  assert.doesNotMatch(rb, /innerHTML|insertAdjacentHTML|outerHTML/);
});

await t('tours: Discovery + Proposal tours have the banner step; event + flow tours mention it (each tour 4-8 steps)', () => {
  const p = read('public/page-tours.js');
  assert.equal((p.match(/sel: "#flowResumeBanner", need: "edit:quotes", title: "Continue where you left off"/g) || []).length, 2);
  assert.match(p, /Not confirmed yet\? The note above says what is next - Continue where you left off goes there\./);
  assert.match(p, /Opened on another step\? A Continue where you left off note takes you to the step that is next\./);
  const vs = new Set([...readFileSync(new URL('../public/event.html', import.meta.url), 'utf8').matchAll(/page-tours\.js\?v=(\d+)/g)].map((m) => m[1])); assert.ok(+[...vs][0] >= 32);
});

await t('SQL 0356: re-issued in place, 0350 body kept, nothing dropped, editor-safe APPLY, MANIFEST + run-all + checker + release lists', () => {
  const m = read('supabase/migrations/0356_r161_open_quotes_order.sql'), a = read('supabase/APPLY-0356.sql'), mf = read('supabase/migrations/MANIFEST');
  const code = m.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
  assert.doesNotMatch(code, /\b(drop|truncate|delete\s+from|insert\s+into|update\s+public|alter\s+table)\b/i, 'read-only, nothing dropped');
  assert.match(code, /alter function public\.my_open_quotes\(text, int, int, uuid, int\) rename to my_open_quotes__pre0356; end if;/);
  assert.match(code, /if to_regprocedure\('public\.my_open_quotes__pre0356\(text,integer,integer,uuid,integer\)'\) is null then/);
  assert.match(code, /elsif position\('open-quotes-0350' in v_src\) = 0 then\n\s*raise exception 'STOP 0356: my_open_quotes is not the known 0350 body - nothing changed';/);
  assert.match(code, /greatest\(x\.updated_at, x\.last_step_at, x\.my_step_at\) as activity/);
  assert.equal((code.match(/order by z\.activity desc nulls last, z\.created_at desc nulls last, z\.id/g) || []).length, 2);
  assert.match(code, /'created_at', z\.created_at\)\) as r/);
  assert.match(code, /returns jsonb language plpgsql stable security definer set search_path = '' as \$\$/);
  assert.match(code, /grant execute on function public\.my_open_quotes\(text, int, int, uuid, int\) to authenticated/);
  assert.doesNotMatch(code, /grant [^\n]* to (anon|public)\b/i);
  assert.match(code, /revoke all on function public\.my_open_quotes__pre0356\(text, int, int, uuid, int\) from %I', r\); end if;/);
  // the same rows as 0350 (only the ordering + created_at differ)
  const o = read('supabase/migrations/0350_r154c_open_quotes.sql'), body = (s) => s.slice(s.indexOf('create or replace function public.my_open_quotes('), s.indexOf('end $$;', s.indexOf('create or replace function public.my_open_quotes(')));
  const norm = (s) => body(s).replace(/-- open-quotes-035\d[^\n]*\n/, '').replace("greatest(x.updated_at, case when v_scope = 'mine' then x.my_step_at else x.last_step_at end)", 'ACT')
    .replace('greatest(x.updated_at, x.last_step_at, x.my_step_at)', 'ACT').replace(/, z\.created_at desc nulls last/g, '').replace(", 'created_at', z.created_at", '');
  assert.equal(norm(m), norm(o), 'the 0356 body is the 0350 body + ordering only');
  assert.match(a, /^-- APPLY-0356 \(R161 [^\n]*\)\. Run on STAGING first, then production\. Safe to run twice\.\n/);
  assert.ok(a.includes('\nbegin;\n' + m.replace(/\s*$/, '\n') + '\nnotify pgrst, \'reload schema\';\ncommit;\n'), 'begin + migration verbatim + commit');
  assert.equal((a.match(/^begin;$/gm) || []).length, 1); assert.equal((a.match(/^commit;$/gm) || []).length, 1);
  assert.match(a, /\ncommit;\n\n-- VERIFY every line should say true\nselect item, ok from \(values\n[\s\S]*\n\) v\(item, ok\) order by item;\n$/);
  for (const s of [m, a]) {
    assert.ok(/^[\x09\x0a\x20-\x7e]*$/.test(s), 'ASCII only');
    for (const l of s.split('\n')) { const c = l.indexOf('--'); if (c < 0) continue; if ((l.slice(0, c).match(/'/g) || []).length % 2) continue; assert.doesNotMatch(l.slice(c), /['";]/, 'comment with a quote or semicolon: ' + l); }
    assert.doesNotMatch(s, /^\s*\\/m); assert.doesNotMatch(s, /\bcreate\s+(temp|temporary)\s+table\b/i); assert.doesNotMatch(s, /^\s*(set|reset)\s+/im);
  }
  const line = 'forward  supabase/migrations/0356_r161_open_quotes_order.sql';
  assert.equal(mf.split('\n').filter((l) => l === line).length, 1);
  assert.ok(mf.indexOf('forward  supabase/migrations/0350_r154c_open_quotes.sql') < mf.indexOf(line));
  assert.match(mf, /# 0356 \(R161[^\n]*Nothing dropped or deleted\. Safe to run twice\./);
  for (const f of ['test/release-1019.test.mjs', 'test/release-1020.test.mjs']) assert.match(read(f), /'0356'(, '\d{4}')*\]/, f);
  assert.match(read('scripts/db-test/run-all.sh'), /run "r161-open-quotes-order-0356" "R161-OPEN-QUOTES-ORDER-0356: ALL PASS \\\(14\/14\\\)" psql -q -f tests\/db\/r161-open-quotes-order-0356\.sql/);
  assert.match(read('supabase/CHECK-PROD-MIGRATIONS.sql'), /'0356_r161_open_quotes_order'/);
});

console.log(`r161-continue-banner: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
