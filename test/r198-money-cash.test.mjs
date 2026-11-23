// R198 P&L clarity phase 2 (0377): "Cash in & out" and "Who owes what" next to the R197 money header (Settlement, Budget,
// Closure). Pure helpers (dates, lists, chips, the "cash left is not profit" lines, the WhatsApp text, links, the chart), a DOM
// render with fake data (every amount masked in privacy mode, no HTML strings), the tab bar, page wiring, Finance-only, and
// the SQL shape (read-only, finance-gated, definer, additive, APPLY verbatim, MANIFEST / runner / checker / release lists).
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const JS = read('public/money-cash-ui.js'), HJS = read('public/money-header-ui.js'), CSS = read('public/money-header.css'), API = read('public/store-api.js');
const PAGES = { budget: read('public/budget.html'), settlement: read('public/settlement.html'), closure: read('public/closure.html') };
const M = read('supabase/migrations/0377_r198_event_money_cash.sql'), A = read('supabase/APPLY-0377.sql'), MAN = read('supabase/migrations/MANIFEST');
const OVR = JSON.parse(read('supabase/check-prod-overrides.json')), RUN = read('scripts/db-test/run-all.sh'), TOURS = read('public/page-tours.js');
const CHK = read('supabase/CHECK-PROD-MIGRATIONS.sql'), R1019 = read('test/release-1019.test.mjs'), R1020 = read('test/release-1020.test.mjs');
let n = 0, fail = 0;
const t = (name, fn) => { try { fn(); n++; console.log('ok -', name); } catch (e) { fail++; console.log('FAIL -', name, e.message); } };

/* ---- a tiny DOM, enough for the render functions ---- */
class El {
  constructor(tag) { this.tagName = String(tag).toUpperCase(); this.children = []; this.attrs = {}; this._text = ''; this.listeners = {}; this.hidden = false; this.style = {}; this.className = ''; this.id = ''; this.value = '';
    const self = this; this.classList = { add(...c) { c.forEach((x) => { if (!self.className.split(/\s+/).includes(x)) self.className = (self.className + ' ' + x).trim(); }); }, contains(c) { return self.className.split(/\s+/).includes(c); } }; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; }
  get firstChild() { return this.children[0] || null; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  hasAttribute(k) { return k in this.attrs; }
  addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
  click() { (this.listeners.click || []).forEach((f) => f({ target: this, preventDefault() {} })); }
  get clientWidth() { return 600; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  all(pred, out = []) { this.children.forEach((c) => { if (pred(c)) out.push(c); c.all(pred, out); }); return out; }
}
const ids = {};
const doc = { createElement: (x) => new El(x), createElementNS: (ns, x) => new El(x), createTextNode: (s) => { const e = new El('#text'); e._text = String(s); return e; },
  getElementById: (id) => ids[id] || null, body: new El('body') };
function load(withDoc) {
  const ctx = { window: {}, console, URLSearchParams }; if (withDoc) ctx.document = doc; ctx.globalThis = ctx.window; vm.createContext(ctx);
  vm.runInContext(JS.replace(/\}\)\(typeof window !== "undefined" \? window : globalThis\);\s*$/, '})(window);'), ctx);
  return ctx.window.HelmMoneyCash;
}
const C = load(false);
const fmt = (v) => '₹' + Math.round(Math.abs(Number(v) || 0)).toLocaleString('en-IN');

// fake event (the mockup's birthday, 5 days away): advance in, balance due in 4 days, bills and crew coming
const today = '2026-11-17';
const cash = {
  quote_id: 'q-1', title: "Aarav's 5th Birthday", event_date: '2026-11-22', today, closed: false, frozen: false, currency: 'INR',
  entries: [
    { kind: 'payment', dir: 'in', cash: true, done: true, date: '2026-11-01', who: 'Payment from Mehta family', how: 'upi', amount: 106200, act: 'payments' },
    { kind: 'payout', dir: 'out', cash: true, done: true, date: '2026-11-02', who: 'Balloon Bazaar', how: 'Advance', amount: 20000, act: 'bills' },
    { kind: 'client_tds', dir: 'in', cash: false, done: true, date: '2026-11-03', who: 'TDS kept by the client', how: 'Not cash', amount: 2000, act: 'tds' },
    { kind: 'bill', dir: 'out', cash: true, done: false, date: '2026-11-18', who: 'PrintHub', how: 'Bill due', amount: 7800, late: false, act: 'bills' },
    { kind: 'instalment', dir: 'in', cash: true, done: false, date: '2026-11-21', who: 'Balance', how: 'Payment plan', amount: 104200, late: false, act: 'payments' },
    { kind: 'wages', dir: 'out', cash: true, done: false, date: '2026-11-22', who: 'Crew wages (6 people)', how: 'On the event day', amount: 9000, late: false, act: 'crew' },
    { kind: 'bill', dir: 'out', cash: true, done: false, date: '2026-11-10', who: 'Magic Manoj', how: 'Bill due', amount: 5000, late: true, act: 'bills' }],
  points: [
    { date: '2026-11-01', in: 106200, out: 0, in_due: 0, out_due: 0, done: true, run: 106200 },
    { date: '2026-11-02', in: 0, out: 20000, in_due: 0, out_due: 0, done: true, run: 86200 },
    { date: '2026-11-10', in: 0, out: 5000, in_due: 0, out_due: 5000, done: false, run: 81200 },
    { date: '2026-11-18', in: 0, out: 7800, in_due: 0, out_due: 7800, done: false, run: 73400 },
    { date: '2026-11-21', in: 104200, out: 0, in_due: 104200, out_due: 0, done: false, run: 177600 },
    { date: '2026-11-22', in: 0, out: 9000, in_due: 0, out_due: 9000, done: false, run: 168600 }],
  totals: { came_in: 106200, went_out: 20000, to_come: 104200, to_pay: 21800, cash_now: 86200, cash_left: 168600 },
  explain: { cash_left: 168600, profit: 43700, gst_collected: 32400, gst_claimable: 0, gst_to_pay: 32400, gst_blocked: 1200, client_tds: 2000,
             vendor_tds: 0, stock_lost: 0, other: 94500, advance: 106200 },
  owes: {
    client: { name: 'Mehta family', quoted: 212400, received: 106200, tds: 2000, balance: 104200, overdue: false, overdue_amount: 0,
              next: { label: 'Balance', amount: 104200, date: '2026-11-21', days: 4, late: false }, event_title: "Aarav's 5th Birthday", event_date: '2026-11-22', studio: 'Aurora Events' },
    vendors: { total: 12800, count: 2, bills: [
      { id: 'b1', who: 'Magic Manoj', what: 'Magic show', bill_no: 'MM-7', amount: 10000, paid: 5000, open: 5000, part: true, due_date: '2026-11-10', days: -7, late: true, gst: 'none' },
      { id: 'b2', who: 'PrintHub', what: null, bill_no: null, amount: 7800, paid: 0, open: 7800, part: false, due_date: '2026-11-18', days: 1, late: false, gst: 'claimable' }] },
    crew: { total: 9000, people: 6, private: false, per_person: [{ name: 'Kiran', amount: 1500, stage: 'expected', note: null }], date: '2026-11-22', paid_tracked: false },
    claims: { approved: 850, waiting: 300, items: [{ id: 'c1', who: 'Salma', what: 'Sample balloons', amount: 850, status: 'approved' }, { id: 'c2', who: 'Ravi', what: 'Tea', amount: 300, status: 'pending' }] },
    refunds: { total: 0, items: [] },
    gst: { collected: 32400, claimable: 0, to_pay: 32400, credit: 0, blocked: 1200, vendor_tds: 0 }, you_owe: 22950 },
  pay_private: false };

t('dates: "YYYY-MM-DD" parts and whole days from the server today (never the browser clock)', () => {
  assert.deepEqual({ ...C.dparts('2026-11-08') }, { day: '8', mon: 'Nov', short: '8 Nov', full: '8 Nov 2026', y: 2026, m: 11 });
  assert.equal(C.dparts('nope'), null); assert.equal(C.dparts(null), null); assert.equal(C.dparts('2026-13-01'), null);
  assert.equal(C.daysBetween('2026-11-17', '2026-11-21'), 4); assert.equal(C.daysBetween('2026-11-17', '2026-11-10'), -7);
  assert.equal(C.daysBetween('2026-12-31', '2027-01-01'), 1); assert.equal(C.daysBetween('x', '2026-11-01'), null);
  assert.equal(C.whenWords(0), 'today'); assert.equal(C.whenWords(1), 'tomorrow'); assert.equal(C.whenWords(-3), '3 days ago'); assert.equal(C.whenWords(4), 'in 4 days');
  assert.equal(C.how('upi'), 'UPI'); assert.equal(C.how('manual'), 'Recorded by hand'); assert.equal(C.how('Bill due'), 'Bill due'); assert.equal(C.how(''), '');
});
t('lists: coming up soonest first, already happened newest first; chips Overdue / Late / Soon / This week / Not cash', () => {
  const s = C.split(cash.entries);
  assert.deepEqual(Array.from(s.up, (e) => e.date), ['2026-11-10', '2026-11-18', '2026-11-21', '2026-11-22']);
  assert.deepEqual(Array.from(s.done, (e) => e.date), ['2026-11-03', '2026-11-02', '2026-11-01']);
  assert.deepEqual({ ...C.rowChip(cash.entries[6], today) }, { kind: 'bad', text: 'Late' });
  assert.deepEqual({ ...C.rowChip({ ...cash.entries[4], late: true }, today) }, { kind: 'bad', text: 'Overdue' });
  assert.deepEqual({ ...C.rowChip(cash.entries[3], today) }, { kind: 'bad', text: 'Soon' });
  assert.equal(C.rowChip({ dir: 'out', date: '2026-11-20', kind: 'bill' }, today).text, 'This week');
  assert.equal(C.rowChip(cash.entries[5], today), null, 'crew wages on the event day: no alarm chip');
  assert.equal(C.rowChip(cash.entries[2], today).text, 'Not cash');
  assert.equal(C.rowChip(cash.entries[0], today), null);
});
t('cash left is not profit: profit + GST owed + stock lost - client TDS + vendor TDS + the rest = cash left; only non-zero parts', () => {
  const rows = C.explainRows(cash.explain, fmt);
  assert.deepEqual(Array.from(rows, (r) => r.kind), ['profit', 'gst', 'tds', 'other', 'total']);
  assert.equal(rows[1].label, 'GST you owe the government'); assert.equal(rows[1].sign, '+'); assert.equal(rows[1].amount, 32400);
  assert.equal(rows[2].sign, '-'); assert.equal(rows[3].label, 'Costs with no bill or payment in Helm yet');
  const sum = rows.filter((r) => r.kind !== 'total').reduce((a, r) => a + (r.sign === '-' ? -r.amount : r.amount), 0);
  assert.equal(sum, cash.explain.cash_left, 'the parts add up to the cash left');
  const w = C.explainRows({ profit: 250000, gst_collected: 225000, gst_claimable: 117090, gst_to_pay: 107910, stock_lost: 6800, client_tds: 0, vendor_tds: 600, other: -11700, cash_left: 353610 }, fmt);
  assert.deepEqual(Array.from(w, (r) => r.kind), ['profit', 'gst', 'stock', 'vtds', 'other', 'total']);
  assert.match(w[1].sub, /GST collected ₹2,25,000 − GST on vendor bills you can claim back ₹1,17,090/);
  assert.equal(w[4].label, 'Money out that is not a cost (yet)'); assert.equal(w[4].sign, '-');
  assert.equal(C.explainRows({ profit: 1, gst_to_pay: -500, gst_collected: 0, gst_claimable: 500, cash_left: 501 }, fmt)[1].label, 'GST credit from vendor bills');
});
t('WhatsApp reminder: name, event + date, next instalment + due date, total balance when different, studio; never sent by Helm', () => {
  assert.equal(C.waText(cash.owes, fmt), "Hello Mehta family,\nA friendly reminder about Aarav's 5th Birthday on 22 Nov 2026. Balance of ₹1,04,200 is due on 21 Nov 2026.\nThank you! - Aurora Events");
  const late = { client: { ...cash.owes.client, balance: 150000, next: { label: 'Second payment', amount: 50000, date: '2026-11-10', late: true } } };
  assert.match(C.waText(late, fmt), /Second payment of ₹50,000 was due on 10 Nov 2026\.\nTotal balance: ₹1,50,000\./);
  assert.match(C.waText({ client: { balance: 900 } }, fmt), /^Hello,\nA friendly reminder about your event\. The balance of ₹900 is due\./);
  assert.doesNotMatch(JS, /wa\.me|api\.whatsapp|window\.open/);
});
t('links: the same page when it has the place (Settlement), else Settlement / Closure of this event; GST -> Business', () => {
  const here = (id) => id === 'payments' || id === 'vendorBills';
  assert.equal(C.actHref('payments', 'q-1', here), '#payments');
  assert.equal(C.actHref('bills', 'q-1', here), '#vendorBills');
  assert.equal(C.actHref('claims', 'q 1', () => false), 'settlement.html?quote=q%201#claims');
  assert.equal(C.actHref('crew', 'q-1', () => false), 'closure.html?quote=q-1#crewAttendance');
  assert.equal(C.actHref('gst', 'q-1', here), 'business.html');
  assert.equal(C.actHref('nope', 'q-1', here), '');
});
t('chart: one group per date, done solid + due faded, the running line, Today line, narrow labels on a phone', () => {
  const m = C.chartModel(cash.points, today, 700);
  assert.equal(m.line.length, 6); assert.equal(m.end, 168600);
  assert.ok(m.bars.some((b) => b.cls === 'in') && m.bars.some((b) => b.cls === 'in due') && m.bars.some((b) => b.cls === 'out due'));
  assert.ok(m.today > m.line[1].x && m.today < m.line[3].x, 'Today sits between 2 Nov and 18 Nov');
  assert.equal(m.labels[0].text, '1 Nov');
  const p = C.chartModel(cash.points, today, 330); assert.equal(p.W, 330); assert.equal(p.labels[0].text, '1/11');
  assert.ok(p.bars.every((b) => b.x >= 0 && b.x + b.w <= p.W && b.h >= 0), 'bars stay inside the box');
  assert.equal(C.chartModel([], today, 500).line.length, 0);
  assert.equal(C.chartModel(cash.points, today, 99999).W, 760);
});

// DOM render with fake data
const realDoc = globalThis.document; globalThis.document = doc;
const leaksOf = (box) => box.all((e) => e.tagName === '#TEXT' && /₹/.test(e._text) && !(function up(x) { for (let p = x.parentNode; p; p = p.parentNode) if ('data-money' in p.attrs) return true; return false; })(e)).map((e) => e._text);
t('render cash: 4 totals, chart, the sentence, the Cash left ≠ profit box, Coming up + Already happened; every amount masked', () => {
  const R = load(true), box = new El('div');
  R.renderCash(box, cash, fmt);
  const txt = box.textContent;
  for (const w of ['Cash in & out', 'Came in', 'Went out', 'Still to come in', 'Still to pay out', 'Cash left ≠ profit', 'GST you owe the government',
                   'TDS kept by the client', 'Cash left after everyone is paid', 'Coming up', 'Already happened', 'Today', 'is an advance, not profit yet',
                   'cannot claim back', 'That is why cash left is not the same as profit']) assert.ok(txt.includes(w), w);
  assert.ok(box.all((e) => e.tagName === 'SVG' && e.attrs.role === 'img').length === 1, 'one chart');
  assert.ok(box.all((e) => e.tagName === 'PATH' && e.attrs.class === 'mc-run').length === 1, 'running line');
  assert.deepEqual(leaksOf(box), []);
  const lists = box.all((e) => e.tagName === 'UL' && e.className === 'mc-tl');
  assert.equal(lists[0].children.length, 4); assert.equal(lists[1].children.length, 3);
  assert.ok(lists[0].children[0].textContent.includes('Late'));
  assert.ok(lists[1].children[0].textContent.includes('Not cash'));
  assert.ok(box.all((e) => 'data-money' in e.attrs && e.textContent === '+₹1,06,200').length >= 1, 'signed amounts masked');
});
t('render owes: client card (WhatsApp copy, Record payment), vendor bills by due date with Pay, crew per person (admin), pay-backs, GST', () => {
  const R = load(true), box = new El('div');
  ids.payments = new El('div');
  R.renderOwes(box, cash, fmt, { here: (id) => !!ids[id] });
  const txt = box.textContent;
  for (const w of ['Client owes you', 'You owe vendors', 'You owe crew & staff', 'Copy reminder for WhatsApp', 'Record payment', 'Vendor bills to pay',
                   'Overdue - due 10 Nov'.replace(' - ', ' · '), 'Part paid', 'Due 18 Nov · tomorrow', 'Crew wages', 'Helm does not record wage payments',
                   'Pay back Salma', 'Approve first', 'GST to pay (this event)', 'Kiran']) assert.ok(txt.includes(w), w);
  assert.deepEqual(leaksOf(box), []);
  const links = box.all((e) => e.tagName === 'A');
  assert.equal(links.find((a) => a.textContent === 'Record payment').href, '#payments');
  assert.equal(links.find((a) => a.textContent === 'Pay').href, 'settlement.html?quote=q-1#vendorBills');
  assert.equal(links.find((a) => a.textContent === 'Attendance').href, 'closure.html?quote=q-1#crewAttendance');
  // a Finance manager: one wage total, no names
  const b2 = new El('div'); R.renderOwes(b2, { ...cash, owes: { ...cash.owes, crew: { total: 9000, people: 6, private: true, per_person: null } } }, fmt, {});
  assert.ok(b2.textContent.includes('Per-person wages are shown to the studio admin only.')); assert.ok(!b2.textContent.includes('Kiran'));
  // settled client
  const b3 = new El('div'); R.renderOwes(b3, { ...cash, owes: { ...cash.owes, client: { ...cash.owes.client, balance: 0, next: null } } }, fmt, {});
  assert.ok(b3.textContent.includes('Settled') && b3.textContent.includes('Fully paid.') && !b3.textContent.includes('Copy reminder'));
});
globalThis.document = realDoc;

t('tabs: Plan vs actual · Cash in & out · Who owes what, ARIA tabs, drawn on first open, hidden without 0377, Needs attention opens Who owes what', () => {
  assert.match(HJS, /function renderTabs\(box, tabs, state, pref\)/);
  assert.match(HJS, /setAttribute\("role", "tablist"\)/); assert.match(HJS, /setAttribute\("role", "tab"\)/); assert.match(HJS, /setAttribute\("role", "tabpanel"\)/);
  assert.match(HJS, /if \(on && !drawn\[t\.key\]\) \{ drawn\[t\.key\] = true; t\.draw\(panels\[t\.key\]\); \}/);
  assert.match(HJS, /e\.key === "ArrowRight"/);
  assert.match(HJS, /var C = global\.HelmMoneyCash, hasCash = !!\(c && typeof c === "object" && C\);/);
  assert.match(HJS, /B\.moneyCash\.get\(id\)/);
  assert.match(HJS, /tabs\.push\(\{ key: "cash", label: "Cash in & out"/); assert.match(HJS, /tabs\.push\(\{ key: "owes", label: "Who owes what"/);
  assert.match(HJS, /\(a\.kind === "bill_due" \|\| a\.kind === "collect"\) && typeof onOwes === "function"/);
  assert.match(API, /return moneyOnce\.get\(quoteId, "cash", \(\) => softRead\("event_money_cash", \{ p_quote: quoteId \}\)\)/);   // R249: one money call, softRead the fallback   // R206: null without 0377, asked once per page
  assert.match(API, /moneyCash, \/\/ R198 \(0377\)/);
});
t('module: DOM building only, no browser storage, no sends, server does the sums (no adding up in the page)', () => {
  assert.doesNotMatch(JS, /innerHTML|insertAdjacentHTML|outerHTML|document\.write|eval\(|new Function/);
  assert.doesNotMatch(JS, /localStorage|sessionStorage|fetch\(|XMLHttpRequest|\.rpc\(/);
  assert.doesNotMatch(JS, /\.reduce\(/, 'no sums in the page');
  assert.match(CSS, /\.mh-tabs\{display:flex/); assert.match(CSS, /\.mc-tl li\{display:grid/); assert.match(CSS, /@media \(max-width:520px\)\{\n  \.mc-big/);
});
t('pages: Settlement (primary), Budget + Closure ask for cash + owes; money-cash-ui.js linked after store-api; never on the crew link', () => {
  assert.match(PAGES.settlement, /data-mh-parts="header attention cash owes" id="moneyHeader"/);
  assert.match(PAGES.budget, /data-mh-parts="header attention pva cash owes" data-mh-replaces="budgetTiles"/);
  assert.match(PAGES.closure, /data-mh-parts="header attention pva cash owes" id="moneyHeader"/);
  for (const [k, h] of Object.entries(PAGES)) {
    assert.match(h, /<script src="money-cash-ui\.js\?v=\d+"><\/script><script src="money-header-ui\.js\?v=\d+"><\/script>/, k);
    assert.ok(h.indexOf('<script src="money-cash-ui.js') > h.indexOf('<script src="store-api.js'), k + ': after store-api');
  }
  assert.match(PAGES.settlement, /<div class="card" id="claims">/); assert.match(PAGES.settlement, /<div class="card" id="refunds">/);
  for (const p of ['work.html', 'event.html', 'portal.html']) assert.ok(!/money-cash-ui/.test(read('public/' + p)), p);
  assert.match(TOURS, /Cash in & out/); assert.match(TOURS, /Who owes what/);
});
t('SQL 0377: additive + guarded, finance-gated + own studio, read-only, per-person pay admin-only, grants, APPLY verbatim, wired', () => {
  assert.match(M, /raise exception 'STOP 0377: apply 0376 \(event money header\) first'/);
  assert.match(M, /create or replace function public\.event_money_cash\(p_quote uuid\)\nreturns jsonb language plpgsql stable security definer set search_path = ''/);
  assert.match(M, /coalesce\(public\.user_role\(\), ''\) = 'client' or not public\.has_area\('finance', 'view'\) then\n    raise exception 'not authorized' using errcode = '42501'/);
  assert.match(M, /where x\.id = p_quote and x\.org_id = v_org and x\.deleted_at is null;\n  if not found then return null; end if;/);
  assert.match(M, /v_pnl := public\._vb_event_pnl\(p_quote, v_org\);/);
  assert.match(M, /'per_person', case when v_admin then v_people end/);
  assert.match(M, /if r\.src = 'tds' then v_vtds := v_vtds \+ r\.amount; continue; end if;/);
  assert.match(M, /v_other := v_cash_left - v_profit - v_gst_net - v_lost \+ v_tds - v_vtds;/);
  const body = M.slice(M.indexOf('create or replace function public.event_money_cash'), M.indexOf('-- ---- 3) grants'));
  assert.doesNotMatch(body, /\b(insert|update|delete|truncate)\s+(into\s+)?public\./i);
  assert.doesNotMatch(M.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n'), /^\s*(drop|delete|truncate|alter|create table)\b/im);
  assert.ok(![...M].some((c) => c.charCodeAt(0) > 127), 'ASCII only');
  assert.ok(A.includes(M.trim()), 'APPLY embeds the migration verbatim');
  assert.match(A, /^begin;$/m); assert.match(A, /^commit;$/m); assert.match(A, /^select item, ok from \(values$/m);
  assert.doesNotMatch(A, /create temp|temporary table|set_config|^\\/im);
  assert.match(MAN, /forward  supabase\/migrations\/0377_r198_event_money_cash\.sql\n/);
  assert.ok(OVR['0377'] && OVR['0377'].add.includes('marker public.event_money_cash(uuid) r198-0377'));
  assert.match(CHK, /0377_r198_event_money_cash/);
  assert.match(RUN, /run "r198-money-cash-0377" "R198-MONEY-CASH-0377: ALL PASS \\\(19\/19\\\)"/);
  assert.match(R1019, /'0376', '0377'[,\]]/); assert.match(R1020, /'0376', '0377'[,\]]/);
});

console.log(`\n${n} passed, ${fail} failed`);
if (fail) process.exit(1);
