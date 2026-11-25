// R257 (owner, 25 Nov 2026: "Fix all of the problems" from the recorded test of event 11252026-01) - agent G: the saved payment plan is the one source
// of every payment sentence, step 10 after the advance, the studio's name on its own pages, extras on the money pages, no "sent" without a send.
// Pure rules + the wiring; the presses run in a browser with stub data, the SQL in tests/db/r257-owner-film-0443.sql.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const read = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const API = read('public/store-api.js'), FL = read('public/flow.html'), PO = read('public/portal.html'), AP = read('public/approve.html'), BK = read('public/booklet.js'), Q = read('public/quotes.html'),
  SQL = read('supabase/migrations/0443_r257_owner_film.sql'), LV = read('public/link-views.js'), B3 = read('public/builder-3d.js'), INV = read('public/inventory-layout.js');
const fn = (name) => { const a = API.indexOf('  BPStore.' + name + ' = function'); assert.ok(a > 0, name); return API.slice(a, API.indexOf('\n  };', a) + 5); };
const ctx = { BPStore: { todayLocal: () => '2026-11-25', fmtDateIN: (d) => d.slice(8, 10) + '/' + d.slice(5, 7) + '/' + d.slice(0, 4) }, location: { pathname: '/approve', host: 'app.helm.events' }, URL };
vm.runInNewContext(['clock12', 'payPlan', 'payPlanLine', 'payNote', 'paintStudio', 'paymentTerms', 'paidState'].map(fn).join('\n'), ctx);
const S = ctx.BPStore, M = (n) => 'Rs ' + n;
const ROWS = [{ label: 'Advance (30%)', amount: 30000, paid: 0, remaining: 30000, state: 'due', due_date: '2026-11-25', rule: { anchor: 'approval' } }, { label: 'Second payment (30%)', amount: 30000, remaining: 30000, state: 'due', due_date: '2026-11-28' },
  { label: 'Waived', amount: 5, state: 'waived' }, { label: 'Final balance (40%)', amount: 40000, remaining: 40000, state: 'due', due_date: '2026-12-02' }];

test('2 the saved plan in words: never a day that has passed, "due when you approve" before the approval, paid parts skipped', () => {
  let p = S.payPlan(ROWS, { today: '2026-11-25', held: true });
  assert.equal(S.payPlanLine(p, M, null, true), 'Next payment: Advance (30%) Rs 30000, due when you approve. The rest by 02/12/2026.');
  assert.equal(S.payPlanLine(p, M), 'Next payment: Advance (30%) Rs 30000, due when the client approves. The rest by 02/12/2026.');
  p = S.payPlan(ROWS, { today: '2026-11-25' }); assert.match(S.payPlanLine(p, M), /Rs 30000, due now\./); assert.equal(p.left, 100000);
  p = S.payPlan(ROWS, { today: '2026-12-10' }); assert.match(S.payPlanLine(p, M), /due now\. The rest is due now too\.$/); assert.doesNotMatch(S.payPlanLine(p, M), /\d\d\/\d\d/);
  p = S.payPlan(ROWS.map((r, i) => (i ? r : { ...r, state: 'paid', remaining: 0 })), { today: '2026-11-25' }); assert.equal(S.payPlanLine(p, M), 'Next payment: Second payment (30%) Rs 30000, due 28/11/2026. The rest by 02/12/2026.');
  p = S.payPlan([{ label: 'A', amount: 10, state: 'paid', remaining: 0 }], {}); assert.equal(S.payPlanLine(p, M), 'Every payment of the plan is received.');
  assert.equal(S.payPlan([], {}), null); assert.equal(S.payPlan(null), null); assert.equal(S.payPlanLine(null, M), '');
});
test('2 the studio note next to a plan: the advance / balance sentences go, terms such as cancellation stay', () => {
  const n = '30% advance to confirm; balance due 3 days before event. Final terms subject to client agreement.';
  assert.equal(S.payNote(n, true), 'Final terms subject to client agreement.'); assert.equal(S.payNote(n, false), n);
  assert.equal(S.payNote('Balance due 7 days before. Cancellation: 50% of the advance is kept.', true), 'Cancellation: 50% of the advance is kept.');
  assert.equal(S.payNote('', true), '');
});
test('2 without a plan: a due day that has passed is "now"', () => {
  assert.equal(S.paidState({ total: 100, paid: 10, event_date: '2026-11-26', balance_due_days: 3 }).dueNow, true);
  assert.equal(S.paidState({ total: 100, paid: 10, event_date: '2026-12-26', balance_due_days: 3 }).dueNow, false);
  assert.match(PO, /PLAN\|\|!ASKED\?"":ps\.dueNow\?" now":ps\.balanceDue/); assert.match(AP, /ps\.dueNow\?" now":/); assert.match(BK, /< todayOf\(\)\) return "Balance " \+ money\(b\) \+ " due now"/);
  assert.match(FL, /t\.balanceDue<BPStore\.todayLocal\(\) \? /); assert.match(Q, /overdue\?"Balance due now\. "/);
  for (const s of [FL, PO, AP, BK]) assert.match(s, /payPlanLine\(/); assert.match(Q, /plan\.rows\.map\(/);
});
test('2 the booklet: a full plan is the plan - no invented advance on top', () => {
  const B = {}; vm.runInNewContext(BK, { window: B, globalThis: B, document: undefined, console, URLSearchParams, Intl, Date }); const H = B.HelmBooklet || globalThis.HelmBooklet; if (!H) return;
  assert.equal(H.withAdvance([{ label: 'First payment', amount: 50 }, { label: 'Rest', amount: 50 }], 100, { advance_pct: 10 }).length, 2);
  assert.equal(H.withAdvance([{ label: 'Rest', amount: 90 }], 100, { advance_pct: 10 }).length, 2, 'as before when the advance is missing'); assert.equal(H.withAdvance([], 100, { advance_pct: 10 }).length, 1);
});
function step10(o) {
  const src = FL.slice(FL.indexOf('  function planNow(){'), FL.indexOf('  function paintPayForm(nx){'));
  return new Function('BPStore', 'o', `let PAID_SUM=o.paid||0, PSCH=o.sd?{data:o.sd}:null; const quoteTotal=()=>o.total; ${src}; return payNext(o.adv);`)(S, { total: 100000, adv: 30000, ...o });
}
const SD = (paid, x = {}) => ({ today: '2026-11-25', paid, outstanding: 100000 - paid, rows: [{ label: 'Advance (40%)', amount: 40000, paid: Math.min(paid, 40000), remaining: Math.max(0, 40000 - paid), state: paid >= 40000 ? 'paid' : 'due', due_date: '2026-11-25' },
  { label: 'Balance (60%)', amount: 60000, remaining: Math.min(60000, 100000 - paid), state: paid >= 100000 ? 'paid' : 'due', due_date: '2026-11-30' }], ...x });
test('6 / 6b step 10: the plan\'s first payment, then "received" and the next one; the studio default only without a plan', () => {
  let n = step10({ sd: SD(0) }); assert.deepEqual([n.label, n.amount, n.received, n.done], ['Advance (40%)', 40000, false, false]);
  n = step10({ sd: SD(40000), paid: 40000 }); assert.deepEqual([n.label, n.amount, n.received, n.first, n.left], ['Balance (60%)', 60000, true, 40000, 60000]);
  n = step10({ sd: SD(100000), paid: 100000 }); assert.equal(n.done, true);
  n = step10({ sd: SD(0, { mismatch: true }), total: 120000 }); assert.equal(n.amount, 48000, 'price changed: the same % of the new total, as the server re-splits');
  n = step10({ sd: SD(0), paid: 40000 }); assert.equal(n.plan, null, 'an answer older than the receipts is not used (never offers the paid advance)'); assert.notEqual(n.amount, 40000);
  n = step10({}); assert.deepEqual([n.label, n.amount, n.received], ['Advance', 30000, false]); n = step10({ paid: 10000 }); assert.deepEqual([n.label, n.amount], ['Rest of the advance', 20000]);
  n = step10({ paid: 30000 }); assert.deepEqual([n.label, n.amount, n.received], ['Balance', 70000, true]);
  assert.match(FL, /The advance is already paid\. Record another \$\{inr\(amount\)\} \(\$\{mlabel\}\)\?/); assert.match(FL, /some\?"Record a payment":"Record advance payment"/);
  assert.match(FL, /if\(PAID_SUM>was\+0\.5\)\{ \$\("#pay_record"\)\.disabled=false;/, 'enabled again only once the new receipt was read back');
});
test('3 / 9 the studio\'s name on its own pages; a logo only where the page may load it; 9:00 pm', () => {
  assert.equal(S.clock12('21:00'), '9:00 pm'); assert.equal(S.clock12('00:05:00'), '12:05 am'); assert.equal(S.clock12('12:30'), '12:30 pm'); assert.equal(S.clock12('9 pm'), '9 pm'); assert.equal(S.clock12(null), '');
  const made = []; const doc = { b: { textContent: 'x' }, mk: { hidden: false, style: {}, parentNode: { insertBefore: (n) => made.push(n) } }, querySelector(s) { return s === 'header b' ? this.b : this.mk; }, getElementById: () => null,
    createElement: () => ({ style: {}, setAttribute() {}, addEventListener() {} }) };
  assert.equal(S.paintStudio({ name: ' Aurora <b>Events ', logo: 'https://cdn.other.com/l.png' }, doc), true); assert.equal(doc.b.textContent, 'Aurora b Events'); assert.equal(made.length, 0, 'the approval page may not load it');
  assert.equal(S.paintStudio({ name: 'A', logo: 'https://abc.supabase.co/l.png' }, doc), true); assert.equal(made.length, 1); assert.equal(S.paintStudio(null, doc), false); assert.equal(S.paintStudio({ name: '' }, doc), false);
  for (const f of ['approve', 'portal', 'work', 'proposal-view']) { const h = read(`public/${f}.html`); assert.match(h, /BPStore\.paintStudio/); assert.doesNotMatch(h, /<b[^>]*>Helm Events<\/b>/, f); }
  for (const f of ['approve', 'portal', 'work']) assert.match(read(`public/${f}.html`), /Powered by Helm Events<\/footer>/); assert.match(read('public/vendor-request.js'), /\$\("vr-brand"\)\.textContent = String\(d\.studio/);
  assert.match(read('public/crew-self.js'), /Start time " \+ t12\(ci\.expected_start\)/); assert.match(read('public/work.html'), /t12\(r\.start_time\)/);
});
test('vii check-in waits for the server\'s opening time; without 0443 the button is as before', () => {
  const C = read('public/crew-self.js'); const a = C.indexOf('  function opensIn(ci) {');
  const f = new Function('homeAt', C.slice(a, C.indexOf('\n  }', a) + 4) + '; return opensIn;'); const now = Date.now();
  assert.ok(f(now)({ opens_ts: '2026-11-25T12:30:00Z', now_ts: '2026-11-25T10:30:00Z' }) > 7190000); assert.equal(f(now)({ opens_ts: '2026-11-25T10:00:00Z', now_ts: '2026-11-25T10:30:00Z' }), 0); assert.equal(f(now)({ opens_at: '18:00' }), 0);
});
test('5 / 16 a confirmed booking: no "Not opened yet", no "Not confirmed yet"', () => {
  assert.match(LV, /data-lv-done"\) === "1"\) \{ el\.hidden = true; return; \}/); assert.match(LV, /visibilitychange/); assert.match(FL, /n\.dataset\.lvDone=v/);
  assert.match(FL, /if\(PAID_SUM>0 && window\.HelmFlowResume\) HelmFlowResume\.dropBanner\(\)/); assert.match(read('public/flow-resume.js'), /function dropBanner\(\) \{\n    bannerSeq\+\+;/);
});
test('7 no costs is neutral', () => {
  const g = {}; new Function('window', 'globalThis', 'document', read('public/money-header-ui.js').replace(/\}\)\(typeof window[^]*$/, '})(window);'))(g, g, { querySelectorAll: () => [], addEventListener() {}, readyState: 'loading' });
  const H = g.HelmMoneyHeader, h = { light: 'good', revenue: 293200, costs: 0, profit: 293200, margin_pct: 100, target_pct: 25 }; assert.equal(H.noCosts(h), true); assert.match(H.sentence(h).map((x) => x.t).join(''), /^No costs added yet\./);
  assert.equal(H.noCosts({ ...h, costs: 1 }), false); assert.equal(H.noCosts({ ...h, refunds: 5 }), false); assert.equal(H.noCosts({ light: 'none', revenue: 0, costs: 0 }), false);
  assert.match(read('public/insights-costs.js'), /out\.badge = "nc"/);
});
test('11 the badge = what this person can approve now; told at once', () => {
  assert.match(API, /_may: \(sc, t\) => !!sc && !!t && \(sc\.all \|\| \(!sc\.old && !\(t\.crew_id && \(sc\.own \|\| \[\]\)\.includes\(t\.crew_id\)\)\)\)/); assert.match(API, /filter\(\(t\) => this\._may\(sc, t\)\)/);
  assert.match(read('public/approvals.js'), /S\.data\.pending\.filter\(can\)\.length/); const SB = read('public/shell-b.js'); assert.match(SB, /addEventListener\("helm:approvals", /); assert.match(SB, /addEventListener\("helm:approvals-changed"/); assert.match(API, /helm:approvals-changed/);
});
test('14 extras on the money pages: which, where they stand, the warning; never money by itself', () => {
  const X = require('../public/extras-bill.js')._pure, id = (n) => '3333333' + n + '-3333-4333-8333-333333333333';
  const list = { items: [{ id: id(1), what: 'Dessert', qty: 1, cost: 12000, decision: 'bill' }, { id: id(2), what: 'Tables', qty: 2, decision: null }, { id: id(3), what: 'Ice', decision: 'our_cost' }, { id: id(4), what: 'Gone', decision: 'bill', cancelled_at: 'x' }] };
  let r = X.rows(list, []); assert.deepEqual(r.map((z) => [z.x.what, z.state]), [['Dessert', 'bill'], ['Tables', 'decide']]);
  assert.equal(X.warnText(r), '1 extra marked “Bill to client” is not on the bill yet. 1 extra is not decided (bill to client or our cost). You can still close.');
  r = X.rows(list, [{ detail: 'Added on the day. Extra ref ' + X.ref(list.items[0]), status: 'requested' }]); assert.equal(r[0].state, 'asked'); r = X.rows(list, [{ detail: 'Extra ref ' + X.ref(list.items[0]), status: 'approved' }]); assert.equal(r[0].state, 'billed');
  r = X.rows(list, [{ detail: 'Extra ref ' + X.ref(list.items[0]), status: 'rejected' }]); assert.equal(r[0].state, 'refused'); assert.equal(X.warnText(X.rows({ items: [] }, [])), ''); assert.equal(X.title(list.items[1]), 'Tables × 2');
  const J = read('public/extras-bill.js'); assert.doesNotMatch(J, /addChange|milestones\.|record\(|innerHTML/); assert.match(J, /l\.see_cost !== true\) return null/);
  assert.match(read('public/settlement.html'), /id="extrasBill"/); assert.match(read('public/closure.html'), /warn:true/); assert.match(read('public/budget.html'), /chgFromExtra\(\)/);
});
test('i agreed vendors with no bill', () => {
  const a = API.indexOf('    pickNoBill(bk) {'), f = new Function('return ({' + API.slice(a, API.indexOf('\n    },', a) + 6) + '}).pickNoBill')();
  assert.deepEqual(f([{ cost: 45000, status: 'confirmed' }, { cost: 5, status: 'enquiry' }, { cost: 5, status: 'cancelled' }, { cost: 9, settled: true }, { cost: 9, _billed: true }, { cost: null }]), { n: 1, sum: 45000 });
  assert.match(read('public/money-cash-ui.js'), /no bill yet\./);
});
test('ii / iii reserve all: same stock item or type one after the other, at most 3 side by side, progress, leave warning; Undo waits for the save', async () => {
  const a = INV.indexOf('  function lanesOf(qs) {'), src = INV.slice(a, INV.indexOf('  // while it runs: leaving the page', a)); const { lanesOf, runLanes } = new Function(src + '; return { lanesOf, runLanes };')();
  const qs = [{ item_id: 'a', type: 't1' }, { item_id: 'b', type: 't2' }, { item_id: 'a', type: 't3' }, { item_id: 'c', type: 't2' }, { item_id: 'd', type: 't4' }, { item_id: 'e', type: 't5' }];
  const L = lanesOf(qs); assert.equal(L.length, 4); assert.equal(L.flat().length, 6); let live = 0, max = 0, n = 0; const busy = {};
  await runLanes(L, 3, async (q) => { assert.ok(!busy[q.item_id] && !busy[q.type]); busy[q.item_id] = busy[q.type] = 1; live++; max = Math.max(max, live); await new Promise((r) => setTimeout(r, 2)); live--; busy[q.item_id] = busy[q.type] = 0; n++; });
  assert.equal(n, 6); assert.equal(max, 3); assert.match(INV, /addEventListener\("beforeunload", leaveAsk\)/); assert.match(INV, /removeEventListener\("beforeunload", leaveAsk\)/); assert.match(INV, /S\.qbusy \? "Saving\.\.\." : "Undo"/); assert.match(INV, /\.then\(over, function \(e\) \{ over\(\); throw e; \}\)/);
});
test('b nothing says "sent" that was not sent', () => {
  assert.match(API, /payment_receipt: \["🧾", n\.status === "sent" \? "Payment receipt sent" : "Receipt recorded"\]/); assert.doesNotMatch(API, /Payment received — receipt sent/);
  for (const s of [AP, FL]) assert.doesNotMatch(s, /receipt has been sent|both sides are notified/);
});
test('1 / 12 / c / d / iv / vi: the small ones', () => {
  const B = read('public/builder.js'); assert.doesNotMatch(B, /mk\('div','scr-warn'\); wn\.setAttribute\('role','alert'\)/); assert.match(B, /'scr-warn scr-shape'\); wn\.setAttribute\('role','note'\)/); assert.match(B, /\{type:'info', timeout:9000, action:/);
  assert.match(read('public/runsheet.html'), /min-width:148px/); assert.match(B3, /t\.colorSpace=c\.pic \? posterSpace\(\) : THREE\.SRGBColorSpace/); assert.match(API, /function sweepBanners\(\)/);
  assert.doesNotMatch(FL, /Auto-filled from the lead/); assert.match(read('public/flow-polish.css'), /#sec-pay p\.hint,#q_chairsLayout\{font-size:13px/);
});
test('0443: additive, functions only, pinned, kept bodies, read-only check, wired', () => {
  const code = SQL.replace(/--[^\n]*/g, ''); assert.ok(/^[\x00-\x7f]*$/.test(SQL), 'ASCII'); assert.doesNotMatch(code, /\bdrop (table|function|column)\b|\bdelete from\b|\btruncate\b|\balter table\b|create temp|set local|\\ir/i);
  assert.match(SQL.trim(), /\) c\("check", ok\);$/); assert.match(SQL, /revoke all on function %s from public/); assert.equal((code.match(/security definer set search_path = ''/g) || []).length, 8);
  assert.ok(read('supabase/APPLY-0443.sql').includes(SQL.trimEnd())); assert.match(read('supabase/APPLY-0443.sql'), /\nbegin;\n[^]*\ncommit;\n$/); assert.match(read('supabase/migrations/MANIFEST'), /\nforward  supabase\/migrations\/0443_r257_owner_film\.sql\n/);
  assert.match(read('scripts/db-test/run-all.sh'), /R257-OWNER-FILM-0443: ALL PASS \\\(28\/28\\\)/); for (const f of ['1019', '1020']) assert.match(read(`test/release-${f}.test.mjs`), /'0443'/); assert.match(read('tests/db/r249-apply-order-0431.sh'), /443/);
});
