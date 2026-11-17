// R197 P&L clarity phase 1 (0376): the one-glance event money header on Budget, Settlement, Closure and the event page.
// Words (Plan / Expected / Actual / Profit), the sentence that names the margin gap, Needs attention cards, category chips,
// a DOM render with fake data (every amount masked in privacy mode, no HTML strings), page wiring, Finance-only, the
// money rule for the amber band in Settings, and the SQL shape (read-only, finance-gated, definer, additive, APPLY verbatim).
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const JS = read('public/money-header-ui.js'), CSS = read('public/money-header.css'), API = read('public/store-api.js'), LOCK = read('public/money-lock-ui.js');
const PAGES = { budget: read('public/budget.html'), settlement: read('public/settlement.html'), closure: read('public/closure.html'), event: read('public/event.html') };
const M = read('supabase/migrations/0376_r197_event_money_header.sql'), A = read('supabase/APPLY-0376.sql'), MAN = read('supabase/migrations/MANIFEST');
const OVR = JSON.parse(read('supabase/check-prod-overrides.json')), RUN = read('scripts/db-test/run-all.sh'), TOURS = read('public/page-tours.js');
let n = 0, fail = 0;
const t = (name, fn) => { try { fn(); n++; console.log('ok -', name); } catch (e) { fail++; console.log('FAIL -', name, e.message); } };

/* ---- a tiny DOM, enough for the render functions ---- */
class El {
  constructor(tag) { this.tagName = String(tag).toUpperCase(); this.children = []; this.attrs = {}; this._text = ''; this.listeners = {}; this.hidden = false; this.style = {}; this.className = ''; this.id = '';
    const self = this; this.classList = { add(...c) { c.forEach((x) => { if (!self.className.split(/\s+/).includes(x)) self.className = (self.className + ' ' + x).trim(); }); }, contains(c) { return self.className.split(/\s+/).includes(c); } }; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; }
  get firstChild() { return this.children[0] || null; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  hasAttribute(k) { return k in this.attrs; }
  addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
  click() { (this.listeners.click || []).forEach((f) => f({ target: this, preventDefault() {} })); }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  all(pred, out = []) { this.children.forEach((c) => { if (pred(c)) out.push(c); c.all(pred, out); }); return out; }
}
const doc = { createElement: (x) => new El(x), createElementNS: (ns, x) => new El(x), createTextNode: (s) => { const e = new El('#text'); e._text = String(s); return e; } };
function load() {
  const ctx = { window: {}, console, URLSearchParams }; ctx.globalThis = ctx.window; vm.createContext(ctx);
  // first without a document: the module only exports its helpers
  vm.runInContext(JS.replace(/\}\)\(typeof window !== "undefined" \? window : globalThis\);\s*$/, '})(window);'), ctx);
  return ctx.window.HelmMoneyHeader;
}
const H = load();
const fmt = (v) => '₹' + Math.round(Math.abs(Number(v) || 0)).toLocaleString('en-IN');
const text = (parts) => parts.map((p) => p.t).join('');

const closed = { closed: true, frozen: { version: 2, at: '2026-11-10T10:00:00Z', reason: 'late_adjustment' }, live_differs: false, cost_word: 'actual', status: 'closed',
  quoted: 1475000, revenue: 1250000, tax: 225000, received: 1475000, balance: 0, received_pct: 100, client_tds: 0,
  costs: 1000000, costs_plan: 968900, costs_diff: 31100, profit: 250000, margin_pct: 20, plan_profit: 281100, plan_margin_pct: 22.5,
  target_pct: 25, target_set: true, band: 5, light: 'warn', gap_points: 5, rules: 'r21', pay_private: false, refunds: 0,
  reasons: [{ key: 'decor', label: 'Decor & flowers', amount: 32000 }, { key: 'misc', label: 'Misc, petty cash & staff expenses', amount: 8600 }],
  categories: [
    { key: 'decor', label: 'Decor & flowers', plan: 180000, expected: 212000, actual: 212000, diff: 32000, diff_pct: 18, flag: 'over', unplanned: 0, lines: 2, plan_only: false },
    { key: 'food', label: 'Food & catering', plan: 400000, expected: 382000, actual: 382000, diff: -18000, diff_pct: -5, flag: 'under', unplanned: 0, lines: 1, plan_only: false },
    { key: 'misc', label: 'Misc, petty cash & staff expenses', plan: 0, expected: 8600, actual: 8600, diff: 8600, diff_pct: null, flag: 'new', unplanned: 8600, lines: 1, plan_only: false },
    { key: 'contingency', label: 'Contingency (plan only)', plan: 20000, expected: 0, actual: 0, diff: -20000, diff_pct: -100, flag: '', unplanned: 0, lines: 1, plan_only: true }],
  lines: [{ category: 'decor', label: 'Petals & Co', source: 'bill', plan: 150000, expected: 182000, actual: 182000, stage: 'actual', unplanned: false, note: 'actual from 1 vendor bill(s)' },
          { category: 'decor', label: 'Extra garlands', source: 'claim', plan: 0, expected: 30000, actual: 30000, stage: 'actual', unplanned: true, note: null }],
  gap_rule: { pct: 10, abs: 10000 },
  attention: [{ kind: 'bill_due', level: 'bad', who: 'Lumen Lights', amount: 139830, days: 1, count: 3, total: 200000 },
              { kind: 'over_plan', level: 'warn', count: 1, top: { key: 'decor', label: 'Decor & flowers', amount: 32000 } },
              { kind: 'damage', level: 'info', amount: 6800 }] };

t('words: the status chip says Frozen vN once closed, days before the event otherwise', () => {
  assert.deepEqual({ ...H.statusChip(closed) }, { kind: 'good', text: 'Closed · Frozen v2', lock: true });
  assert.equal(H.statusChip({ closed: true }).text, 'Closed');
  assert.equal(H.statusChip({ days_to_event: 5 }).text, 'In 5 days');
  assert.equal(H.statusChip({ days_to_event: 1 }).text, 'Event tomorrow');
  assert.equal(H.statusChip({ days_to_event: 0 }).text, 'Event today');
  assert.equal(H.statusChip({ days_to_event: -3 }).text, 'Event 3 days ago · not closed');
  assert.equal(H.statusChip({ status: 'cancelled' }).kind, 'bad');
  assert.equal(H.lightLabel('good'), 'On target'); assert.equal(H.lightLabel('warn'), 'Just below target');
  assert.equal(H.lightLabel('bad'), 'Well below target'); assert.equal(H.lightLabel('bad', true), 'Loss');
});
t('sentence (closed, below target): what you kept, the margin, points below the target, the two biggest reasons', () => {
  const s = text(H.sentence(closed, fmt));
  assert.equal(s, 'You kept ₹2,50,000 from this event (20% margin). That is 5 points below your 25% target, mainly Decor & flowers (+₹32,000) and Misc, petty cash & staff expenses (+₹8,600).');
  const parts = H.sentence(closed, fmt);
  assert.ok(parts.some((p) => p.t === '₹2,50,000' && p.b && p.m), 'the profit is bold and masked');
  assert.ok(parts.some((p) => p.t === '+₹32,000' && p.m), 'reason amounts are masked');
});
t('sentence (open): expected profit, the plan, "there is still time"; at target; a loss; no price; plan itself below target', () => {
  const open = { ...closed, closed: false, frozen: null, cost_word: 'expected', margin_pct: 24.3, plan_margin_pct: 27, gap_points: 0.7, profit: 43700 };
  assert.equal(text(H.sentence(open, fmt)), 'If everything goes as booked you will keep ₹43,700 (24.3%). You planned 27%. That is 0.7 points below your 25% target, mainly Decor & flowers (+₹32,000) and Misc, petty cash & staff expenses (+₹8,600). There is still time to fix it.');
  assert.match(text(H.sentence({ ...closed, gap_points: -3, margin_pct: 28 }, fmt)), /That is at or above your 25% target\.$/);
  assert.match(text(H.sentence({ ...closed, profit: -12000, light: 'bad' }, fmt)), /^This event lost ₹12,000\. Mainly Decor/);
  assert.match(text(H.sentence({ light: 'none', revenue: 0 }, fmt)), /no price yet/);
  assert.match(text(H.sentence({ ...closed, reasons: [], plan_margin_pct: 21 }, fmt)), /5 points below your 25% target: the plan itself was below the target \(21%\)\.$/);
  assert.equal(H.points(1), '1 point'); assert.equal(H.points(4.5), '4.5 points'); assert.equal(H.pnum(20.0), '20');
});
t('Needs attention: a bill to pay, money to collect, margin, over plan, unplanned, damage, attendance', () => {
  const b = H.attention(closed.attention[0], fmt);
  assert.equal(b.level, 'bad'); assert.equal(text(b.title), 'Pay Lumen Lights ₹1,39,830 tomorrow'); assert.equal(b.sub, '2 more vendor bills open on this event.');
  assert.ok(b.title.some((p) => p.m && p.t === '₹1,39,830'));
  assert.equal(text(H.attention({ kind: 'bill_due', who: 'X', amount: 5, days: -4, count: 1 }, fmt).title), 'Pay X ₹5 · overdue by 4 days');
  const c = H.attention({ kind: 'collect', level: 'warn', amount: 106200, label: 'Balance', days: 2 }, fmt);
  assert.equal(text(c.title), 'Collect ₹1,06,200 from the client'); assert.equal(c.sub, 'Balance due in 2 days. Record it on Payments & invoice.');
  assert.equal(H.attention({ kind: 'collect', amount: 1, label: 'Balance', days: -2 }, fmt).sub, 'Balance was due 2 days ago. Record it on Payments & invoice.');
  const m = H.attention({ kind: 'margin', level: 'warn', margin: 20, target: 25, gap: 5 }, fmt);
  assert.equal(text(m.title), 'Profit 20% is below your 25% target'); assert.match(m.sub, /^5 points below/);
  assert.equal(text(H.attention({ kind: 'margin', level: 'bad', loss: true }, fmt).title), 'This event is making a loss');
  const o = H.attention(closed.attention[1], fmt); assert.equal(text(o.title), '1 category well over the plan'); assert.equal(o.top.key, 'decor');
  assert.equal(text(H.attention({ kind: 'unplanned', amount: 4000, count: 2 }, fmt).title), 'Unplanned spends ₹4,000');
  assert.match(text(H.attention({ kind: 'damage', amount: 6800 }, fmt).title), /Damage & loss ₹6,800 counted as a cost/);
  assert.equal(text(H.attention({ kind: 'attendance', count: 3 }, fmt).title), 'Confirm crew attendance (3 people)');
});
t('category chips: over by N% (the big-gap flag), unplanned, watch, saved, plan only', () => {
  assert.deepEqual({ ...H.chip(closed.categories[0], fmt) }, { kind: 'bad', text: 'Over by 18%' });
  assert.equal(H.chip(closed.categories[1], fmt).text, 'Saved ₹18,000'); assert.equal(H.chip(closed.categories[1], fmt).kind, 'good');
  assert.deepEqual({ ...H.chip(closed.categories[2], fmt) }, { kind: 'warn', text: 'Unplanned' });
  assert.equal(H.chip(closed.categories[3], fmt).text, 'Plan only');
  assert.deepEqual({ ...H.chip({ plan: 0, diff: 15000, flag: 'over' }, fmt) }, { kind: 'bad', text: 'Unplanned' });
  assert.deepEqual({ ...H.chip({ plan: 100, diff: 8, diff_pct: 8, flag: 'watch' }, fmt) }, { kind: 'warn', text: 'Watch +8%' });
});

// DOM render with fake data
const realDoc = globalThis.document; globalThis.document = doc;
t('render: header + attention + plan vs actual build with DOM nodes, every amount carries data-money', () => {
  const ctx = { window: {}, document: doc, console, URLSearchParams }; ctx.globalThis = ctx.window; vm.createContext(ctx);
  vm.runInContext(JS.replace(/\}\)\(typeof window !== "undefined" \? window : globalThis\);\s*$/, '})(window);').replace('if (document.readyState === "loading")', 'if (false)').replace(/else start\(\);/, ''), ctx);
  const R = ctx.window.HelmMoneyHeader, box = new El('div');
  R.renderHeader(box, closed, fmt); R.renderAttention(box, closed, fmt, () => {});
  const state = { open: {}, uid: 1 }; R.renderPva(box, closed, fmt, state);
  const txt = box.textContent;
  for (const w of ['Quoted (with GST)', 'Received', 'Actual costs', 'Profit', '20% · Just below target', 'target 25%', 'Closed · Frozen v2',
                   'Plan vs actual by category', 'How the profit is worked out', 'Profit = revenue without GST minus every cost of this event']) assert.ok(txt.includes(w), w);
  for (const bad of ['Committed', 'Contribution', 'Variance', 'Gross margin', 'Estimated']) assert.ok(!txt.includes(bad), 'no "' + bad + '"');
  const moneyNodes = box.all((e) => 'data-money' in e.attrs);
  assert.ok(moneyNodes.some((e) => e.textContent === '₹2,50,000'), 'profit masked');
  assert.ok(moneyNodes.some((e) => e.textContent === '₹14,75,000'), 'quoted masked');
  // every visible rupee amount sits inside a data-money node
  const leaks = box.all((e) => e.tagName === '#TEXT' && /₹/.test(e._text) && !(function up(n) { for (let p = n.parentNode; p; p = p.parentNode) if ('data-money' in p.attrs) return true; return false; })(e));
  assert.deepEqual(leaks.map((e) => e._text), []);
  // rows open to their lines (aria-expanded), the plan line is drawn, over-plan fill is red
  const rows = box.all((e) => e.tagName === 'BUTTON' && e.className === 'mh-r');
  assert.equal(rows.length, 4);
  const decor = rows[0]; assert.equal(decor.getAttribute('aria-expanded'), 'false');
  const det = box.all((e) => e.id === decor.getAttribute('aria-controls'))[0]; assert.ok(det.hidden);
  decor.click(); assert.equal(decor.getAttribute('aria-expanded'), 'true'); assert.equal(det.hidden, false); assert.equal(state.open.decor, true);
  assert.ok(det.textContent.includes('Petals & Co') && det.textContent.includes('Unplanned'));
  assert.ok(box.all((e) => e.tagName === 'I' && e.className === 'over').length >= 1);
  assert.ok(box.all((e) => e.tagName === 'B' && /calc\(/.test(e.style.left || '')).length >= 2);
  // the live-figure note for a frozen event whose live numbers moved (0372 rule)
  const b2 = new El('div'); R.renderHeader(b2, { ...closed, live_differs: true, live_profit: 241400 }, fmt);
  assert.match(b2.textContent, /Frozen v2 figure\. Live numbers now say ₹2,41,400/);
  // an open event says Expected
  const b3 = new El('div'); R.renderHeader(b3, { ...closed, closed: false, frozen: null, cost_word: 'expected', days_to_event: 5 }, fmt);
  assert.ok(b3.textContent.includes('Expected costs') && b3.textContent.includes('Expected profit') && b3.textContent.includes('In 5 days'));
});
globalThis.document = realDoc;

t('module: DOM building only, Finance-only mount, server call only, refreshes on money events, no browser storage', () => {
  assert.doesNotMatch(JS, /innerHTML|insertAdjacentHTML|outerHTML|document\.write|eval\(|new Function/);
  assert.doesNotMatch(JS, /localStorage|sessionStorage/);
  assert.match(JS, /B\.auth\.canView\("finance"\)/);
  assert.match(JS, /if \(!fin\) \{ box\.hidden = true; return; \}/);
  assert.match(JS, /B\.moneyHeader\.get\(id\)/);
  assert.match(JS, /"helm:pnl-refresh", "helm:vendor-bills-changed", "helm:settlement-loaded"/);
  assert.match(JS, /global\.HelmPageQuote/);
  assert.match(API, /rpc\("event_money_header", \{ p_quote: quoteId \}\)/);
  assert.match(API, /moneyHeader, \/\/ R197 \(0376\)/);
  assert.match(CSS, /@media \(max-width:760px\)/); assert.match(CSS, /\.mh-attn\{display:grid/);
});
t('pages: Budget / Closure get header + attention + plan vs actual (+ R198 cash / owes tabs), Settlement header + attention (+ cash / owes), event header + attention; scripts + CSS linked', () => {
  assert.match(PAGES.budget, /<div data-mh-mount data-mh-parts="header attention pva cash owes" data-mh-replaces="budgetTiles" id="moneyHeader" hidden><\/div>/);
  assert.match(PAGES.budget, /<div class="tiles" id="budgetTiles">/);
  assert.match(PAGES.closure, /<div data-mh-mount data-mh-parts="header attention pva cash owes" id="moneyHeader" hidden><\/div>/);
  assert.match(PAGES.settlement, /<div data-mh-mount data-mh-parts="header attention cash owes" id="moneyHeader" hidden><\/div>/);
  assert.match(PAGES.event, /<div data-mh-mount data-mh-parts="header attention" id="moneyHeader" hidden><\/div>/);
  for (const [k, h] of Object.entries(PAGES)) {
    assert.match(h, /<script src="money-header-ui\.js\?v=\d+"><\/script>/, k);
    assert.match(h, /<link rel="stylesheet" href="money-header\.css\?v=\d+">/, k);
    assert.ok(h.indexOf('<script src="money-header-ui.js') > h.indexOf('<script src="store-api.js'), k + ': after store-api');
  }
  for (const k of ['budget', 'settlement', 'closure', 'event']) assert.match(TOURS, /sel: \[?"#moneyHeader"/, k);
  assert.ok(!/money-header-ui/.test(read('public/work.html')), 'never on the crew link');
});
t('Settings -> Money rules: the amber band only when the server knows it (0376); the target stays in its own card', () => {
  assert.match(LOCK, /if \(has\(c\.margin_band\)\) \{/);
  assert.match(LOCK, /nf\(g3, "margin_band", "Traffic light: amber while the profit is up to this many points below the target"/);
  assert.match(LOCK, /Change the target in the Target margin card\./);
  assert.doesNotMatch(LOCK, /"target_margin_pct"\s*[,:]\s*\{/);   // no second target-margin editor
});
t('SQL 0376: additive + guarded, finance-gated + own studio, read-only header, kept bodies, ranges, grants, APPLY verbatim', () => {
  assert.match(M, /raise exception 'STOP 0376: apply 0372 \(money lock\) first'/);
  assert.match(M, /create or replace function public\.event_money_header\(p_quote uuid\)\nreturns jsonb language plpgsql stable security definer set search_path = ''/);
  assert.match(M, /coalesce\(public\.user_role\(\), ''\) = 'client' or not public\.has_area\('finance', 'view'\) then\n    raise exception 'not authorized' using errcode = '42501'/);
  assert.match(M, /where x\.id = p_quote and x\.org_id = v_org and x\.deleted_at is null;\n  if not found then return null; end if;/);
  assert.match(M, /v_pnl := public\._vb_event_pnl\(p_quote, v_org\);/);
  assert.match(M, /s := public\._r372_current_snapshot\(p_quote\);/);
  assert.match(M, /public\._r376_lines\(v_money -> 'lines', v_admin\)/);
  assert.match(M, /alter table public\.money_settings add column if not exists margin_band numeric not null default 5;/);
  assert.match(M, /check \(margin_band >= 0 and margin_band <= 50\)/);
  assert.match(M, /alter function public\.money_settings_get\(\) rename to money_settings_get__pre0376;/);
  assert.match(M, /alter function public\.money_settings_set\(jsonb\) rename to money_settings_set__pre0376;/);
  assert.match(M, /'default_pct', 25/);
  // the header body never writes
  const body = M.slice(M.indexOf('create or replace function public.event_money_header'), M.indexOf('-- ---- 6) grants'));
  assert.doesNotMatch(body, /\b(insert|update|delete|truncate)\s+(into\s+)?public\./i);
  assert.doesNotMatch(M.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n'), /^\s*(drop|delete|truncate)\b/im);
  assert.ok(![...M].some((c) => c.charCodeAt(0) > 127), 'ASCII only');
  assert.ok(A.includes(M.trim()), 'APPLY embeds the migration verbatim');
  assert.match(A, /^begin;$/m); assert.match(A, /^commit;$/m); assert.match(A, /^select item, ok from \(values$/m);
  assert.doesNotMatch(A, /create temp|temporary table|set_config|^\\/im);
  assert.match(MAN, /forward  supabase\/migrations\/0376_r197_event_money_header\.sql/);
  assert.ok(OVR['0376'] && OVR['0376'].add.includes('marker public.event_money_header(uuid) r197-0376'));
  assert.match(RUN, /run "r197-money-header-0376" "R197-MONEY-HEADER-0376: ALL PASS \\\(22\/22\\\)"/);
});

console.log(`\n${n} passed, ${fail} failed`);
if (fail) process.exit(1);
