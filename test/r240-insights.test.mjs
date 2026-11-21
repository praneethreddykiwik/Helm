// r240-insights.test.mjs - R240 "We need to improve our Insights page" (owner 20 Nov 2026):
//  * store-api: Insights-only period choices (Last 7 days / Last 6 months / Last 12 months), presets(keys), prevRange = the
//    server's _r405_prev_range on the same cases, insights.overview -> insights_overview (0405), summary({ margins: false })
//  * insights-overview.js pure helpers: change vs previous period, ledger totals = HelmInsightsCosts.moneyByCurrency (the
//    Money tiles' function), package revenue = plain sums of the ledger rows, margin trend from the ledger rows, CSV guard
//  * insights.html wiring (hosts, script order, export refused while amounts are hidden, F2 re-ask when 500 rows come back,
//    the cost card keeps its own 12 months), CSP-safe DOM, page tour, migration 0405 read-only + APPLY + MANIFEST + run-all
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const API = read('public/store-api.js'), RB = read('public/range-bar.js'), INS = read('public/insights.html'),
  IO = read('public/insights-overview.js'), CSS = read('public/insights-polish.css'), TOURS = read('public/page-tours.js');
const SQL = read('supabase/migrations/0405_r240_insights_overview.sql'), APPLY = read('supabase/APPLY-0405.sql'),
  DBT = read('tests/db/r240-insights-overview-0405.sql'), MAN = read('supabase/migrations/MANIFEST'), RUN = read('scripts/db-test/run-all.sh');
let n = 0, fail = 0;
const t = (name, fn) => { try { fn(); n++; console.log('  ok ' + name); } catch (e) { fail++; console.error('  FAIL ' + name + '\n' + (e && e.stack || e)); } };
const fnSrc = (src, name) => {
  const at = src.indexOf(`function ${name}(`); assert.ok(at >= 0, name + ' missing');
  let i = src.indexOf('{', src.indexOf(')', at)), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1); }
  throw new Error(name + ' unterminated');
};
const constSrc = (src, name) => { const at = src.indexOf(`const ${name} =`); assert.ok(at >= 0, name); return src.slice(at, src.indexOf(';\n', at) + 1); };
const ctx = {};
vm.runInNewContext([constSrc(API, 'RANGE_PRESETS'), constSrc(API, 'RANGE_EXTRA'), constSrc(API, 'INSIGHTS_RANGE_KEYS'),
  fnSrc(API, 'rangeFor'), fnSrc(API, 'rangeCheck'), fnSrc(API, 'prevRange'),
  'globalThis.X={RANGE_PRESETS,RANGE_EXTRA,INSIGHTS_RANGE_KEYS,rangeFor,rangeCheck,prevRange};'].join('\n'), ctx);
const X = ctx.X, J = (v) => JSON.parse(JSON.stringify(v));
const IC = require('../public/insights-costs.js');
globalThis.HelmInsightsCosts = IC;
const O = require('../public/insights-overview.js');

console.log('r240 insights');
t('periods: Reports keeps its list; Insights adds Last 7 days / Last 6 months / Last 12 months', () => {
  assert.deepEqual(J(X.RANGE_PRESETS.map((p) => p[1])), ['Today', 'Last day', 'This month', 'Last month', 'This year', 'Custom range']);
  assert.deepEqual(J(X.INSIGHTS_RANGE_KEYS), ['last_7', 'this_month', 'last_month', 'last_6m', 'last_12m', 'this_year', 'custom']);
  const d = new Date(2026, 10, 20);   // 20 Nov 2026
  assert.deepEqual(J(X.rangeFor('last_7', d)), { from: '2026-11-14', to: '2026-11-20' });
  assert.deepEqual(J(X.rangeFor('last_6m', d)), { from: '2026-06-01', to: '2026-11-30' });
  assert.deepEqual(J(X.rangeFor('last_12m', d)), { from: '2025-12-01', to: '2026-11-30' });
  assert.deepEqual(J(X.rangeFor('last_6m', new Date(2026, 1, 10))), { from: '2025-09-01', to: '2026-02-28' });
  // presets(keys) keeps the order asked for and every label is known
  const all = X.RANGE_PRESETS.concat(X.RANGE_EXTRA);
  X.INSIGHTS_RANGE_KEYS.forEach((k) => assert.ok(all.some((p) => p[0] === k), k));
  assert.match(API, /presets: \(keys\) => \{ const all = RANGE_PRESETS\.concat\(RANGE_EXTRA\);/);
  assert.match(RB, /var presets = S\.presets\(opts\.keys\);/);
  assert.match(INS, /keys:BPStore\.insights\.INSIGHTS_RANGE_KEYS/);
});
t('previous period = the server rule (_r405_prev_range) on the same cases as the DB suite + APPLY check rows', () => {
  const cases = [[['2026-03-01', '2026-03-31'], ['2026-02-01', '2026-02-28']], [['2026-06-01', '2026-11-30'], ['2025-12-01', '2026-05-31']],
    [['2026-11-14', '2026-11-20'], ['2026-11-07', '2026-11-13']], [['2024-03-01', '2024-03-31'], ['2024-02-01', '2024-02-29']],
    [['2026-01-01', '2026-12-31'], ['2025-01-01', '2025-12-31']], [['2026-11-01', '2026-11-30'], ['2026-10-01', '2026-10-31']],
    [['2026-03-31', '2026-03-31'], ['2026-03-30', '2026-03-30']]];
  cases.forEach(([a, b]) => assert.deepEqual(J(X.prevRange(a[0], a[1])), { from: b[0], to: b[1] }, a.join('..')));
  assert.equal(X.prevRange('2026-03-31', '2026-03-01'), null);
  cases.slice(0, 5).forEach(([a, b]) => assert.ok(DBT.includes(`'${a[0]}', '${a[1]}'`) || DBT.includes(`'${b[0]}'`), 'DB suite has ' + a));
  assert.ok(APPLY.includes("public._r405_prev_range('2026-06-01', '2026-11-30') = array['2025-12-01'::date, '2026-05-31']"));
});
t('store-api: overview -> insights_overview(p_from, p_to, p_currency) with the 0405 message; summary can skip margins', () => {
  assert.match(API, /rpc\("insights_overview", \{ p_from: from, p_to: to, p_currency: \/\^\[A-Z\]\{3\}\$\/\.test\(cur\) \? cur : null \}\)/);
  assert.match(API, /er\.code = "insights_overview_missing"/);
  assert.match(API, /need database update 0405 \(ask your admin to run APPLY-0405\.sql\)/);
  assert.match(API, /const closed = noMargins \? \[\] : events\.filter/);
  assert.match(INS, /BPStore\.insights\.summary\(\{from:r\.from,to:r\.to\},\{margins:false\}\)/);
});
t('change vs previous period: counts, points, money, "new", bad-direction for cancellations', () => {
  assert.deepEqual(J(O.delta(12, 8, 'count')), { dir: 'up', good: true, text: '+4 (+50%)' });
  assert.deepEqual(J(O.delta(3, 6, 'count', true)), { dir: 'down', good: true, text: '-3 (-50%)' });
  assert.deepEqual(J(O.delta(6, 3, 'count', true)), { dir: 'up', good: false, text: '+3 (+100%)' });
  assert.deepEqual(J(O.delta(40, 52, 'pct')), { dir: 'down', good: false, text: '-12 pts' });
  assert.deepEqual(J(O.delta(110000, 100000, 'money')), { dir: 'up', good: true, text: '+10%' });
  assert.deepEqual(J(O.delta(-500, 1000, 'money')), { dir: 'down', good: false, text: '-150%' });
  assert.deepEqual(J(O.delta(5, 0, 'count')), { dir: 'new', good: true, text: 'new' });
  assert.deepEqual(J(O.delta(4, 4, 'count')), { dir: 'same', good: null, text: 'same' });
  assert.equal(O.delta(null, 3, 'count').dir, null);
  assert.equal(O.pct(1, 3), 33); assert.equal(O.pct(1, 0), null);
});
const LED = [
  { id: 'e1', code: 'E-1', date: '2026-03-05', stage: 'closed', currency: 'INR', revenue: 100000, profit: 30000, cost_total: 70000, margin_pct: 30, collected: 50000, outstanding: 50000, expense_claims: 1000 },
  { id: 'e2', code: 'E-2', date: '2026-03-20', stage: 'planning', currency: 'INR', revenue: 50000, profit: -5000, cost_total: 55000, margin_pct: -10, collected: 0, outstanding: 50000 },
  { id: 'e3', code: 'E-3', date: '2026-03-21', stage: 'closed', currency: 'AED', revenue: 8000, profit: 2000, cost_total: 6000, margin_pct: 25 },
  { id: 'e4', code: 'E-4', date: '2026-02-11', stage: 'closed', currency: 'INR', revenue: 40000, profit: 10000, cost_total: 30000, margin_pct: 25 },
  { id: 'e5', code: 'E-5', date: '2026-03-25', stage: 'closed', currency: 'INR', revenue: 0, profit: -200, cost_total: 200 },
];
t('ledger totals = HelmInsightsCosts.moneyByCurrency (the Money tiles), per currency, period only', () => {
  const a = O.ledgerTotals(LED, '2026-03-01', '2026-03-31');
  assert.deepEqual(J(a), J(IC.moneyByCurrency(LED, '2026-03-01', '2026-03-31')));
  assert.equal(a.INR.revenue_ex_tax, 150000); assert.equal(a.INR.profit, 24800); assert.equal(a.AED.revenue_ex_tax, 8000);
  assert.equal(O.ledgerTotals(LED, '2026-02-01', '2026-02-28').INR.profit, 10000);
});
t('package revenue = plain sums of the ledger rows of its events (no other money), per currency', () => {
  const p = O.packageRevenue([{ name: 'Gold', events: 3, ids: ['e1', 'e2', 'e3'] }, { name: 'Silver', events: 1, ids: ['zz'] }], LED);
  assert.deepEqual(J(p[0].money), [{ currency: 'AED', revenue: 8000, profit: 2000 }, { currency: 'INR', revenue: 150000, profit: 25000 }]);
  assert.equal(p[0].matched, 3); assert.equal(p[1].matched, 0); assert.deepEqual(J(p[1].money), []);
});
t('margin trend from the ledger: closed events of the period only, profit = ledger profit, no-revenue kept apart', () => {
  const m = O.marginsFromLedger(LED, '2026-03-01', '2026-03-31');
  assert.deepEqual(J(m.events.map((x) => x.code)), ['E-1', 'E-3', 'E-5']);
  assert.deepEqual(J(m.withRevenue.map((x) => [x.code, x.profit, x.marginPct])), [['E-1', 30000, 30], ['E-3', 2000, 25]]);
  assert.deepEqual(J(m.noRevenue.map((x) => x.code)), ['E-5']);
  assert.equal(m.avgMargin, 28);
  const inr = m.byCurrency.find((g) => g.currency === 'INR');
  assert.deepEqual(J(inr), { currency: 'INR', events: 2, totalProfit: 29800, revenue: 100000, avgMargin: 30 });
  assert.match(INS, /HelmInsightsOverview\.marginsFromLedger\(ledger,r\.from,r\.to\)/);
});
const OV = { from: '2026-03-01', to: '2026-03-31', prev_from: '2026-02-01', prev_to: '2026-02-28', finance: true, leads: true, quotes: true,
  funnel: { cur: { enquiries: 4, enquiries_won: 2, enquiries_lost: 1, quotes_made: 3, quotes_won: 1, quotes_cancelled: 1, quotes_open: 1, bookings: 2, cancellations: 3 },
    prev: { enquiries: 1, enquiries_won: 0, enquiries_lost: 0, quotes_made: 2, quotes_won: 1, quotes_cancelled: 0, quotes_open: 1, bookings: 1, cancellations: 0 } },
  sources: [{ source: '=HYPERLINK("x")', enquiries: 2, won: 1, lost: 1 }, { source: 'none', enquiries: 1, won: 0, lost: 0 }],
  months: [{ month: '2026-03', enquiries: 4, quotes_made: 3, bookings: 2 }],
  packages: { list: [{ name: 'Gold', events: 2, ids: ['e1', 'e2'] }], without: 1 },
  upcoming: { total: 1, events: [{ id: 'u', code: 'U-1', title: 'Soon', date: '2026-03-24', stage: 'ready', tasks: 3, tasks_open: 2, tasks_unassigned: 1, crew: 1 }] },
  cancellations: { reasons: [{ reason: '+cmd', count: 2 }], no_reason: 0 },
  payments: { overdue: { count: 1, list: [{ code: 'D-1', client: '@Meera', label: 'Advance', due_date: '2026-03-01', days_late: 19, currency: 'INR', balance: 2500 }] } } };
t('CSV: every section, plain numbers, formula cells neutralised, amounts only with Finance', () => {
  const csv = O.toCSV(O.csvRows(OV, LED, {}));
  assert.match(csv, /^Helm Insights,2026-03-01 to 2026-03-31,previous period 2026-02-01 to 2026-02-28/);
  assert.match(csv, /\nEnquiries,4,1\n/); assert.match(csv, /\nQuote win rate %,33,50\n/); assert.match(csv, /\nEnquiry conversion %,50,0\n/);
  assert.match(csv, /\nRevenue ex-tax INR,150000,40000\n/); assert.match(csv, /\nProfit INR,24800,10000\n/);
  assert.ok(csv.includes(`"'=HYPERLINK(""x"")",2,1,1,50`), 'formula source guarded');
  assert.ok(csv.includes('\nNot recorded,1,0,0,0'));
  assert.ok(csv.includes("\n'+cmd,2") && csv.includes(",'@Meera,"), 'reason + client guarded');
  assert.ok(csv.includes('\nGold,2,INR,150000,25000'));
  assert.ok(csv.includes('\nE-1,2026-03-05,INR,100000,70000,30000,30,50000,50000'));
  assert.ok(!/[₹]/.test(csv), 'no formatted money');
  const noFin = O.toCSV(O.csvRows(Object.assign({}, OV, { finance: false }), null, {}));
  assert.ok(!/Revenue ex-tax|Overdue payment|Outstanding|150000|2500/.test(noFin), 'no amounts without Finance');
  assert.ok(noFin.includes('\nGold,2'));
  [' =1+1', '　@SUM(A1)', '＝1', '-2+3'].forEach((s) => assert.equal(O.cell(s)[0] === "'" || O.cell(s).startsWith('"\''), true, s));
  assert.equal(O.cell('Rs 1,000'), '"Rs 1,000"'); assert.equal(O.cell(-5), '-5');
});
t('CSP-safe DOM: no HTML strings / inline styles; amounts carry data-money and mask while hidden', () => {
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML|document\.write|setAttribute\("style"|\.style\.cssText|eval\(|new Function/.test(IO));
  assert.match(IO, /el\.setAttribute\("data-money", ""\)/);
  assert.match(IO, /var M = function \(n, c\) \{ return hidden\(\) \? MASK :/);
  assert.match(IO, /attributeFilter: \["class"\]/);   // re-draw on the eye button
  assert.equal(O.MASK, '••••');
});
t('insights.html: hosts, script order, export refused while hidden, F2 re-ask on 500 rows, cost card keeps 12 months', () => {
  ['ioGlance', 'ioFunnelCard', 'ioFunnel', 'ioPayCard', 'ioPay', 'ioUpCard', 'ioUp', 'ioPkg', 'ioCx', 'ioExport', 'ioExportMsg'].forEach((id) => assert.ok(INS.includes(`id="${id}"`), id));
  assert.match(INS, /<section class="card" id="ioPayCard" aria-labelledby="ioPayH" hidden>/);
  const a = INS.indexOf('insights-costs.js?v='), b = INS.indexOf('<script src="insights-overview.js?v='), c = INS.indexOf('<script>\n  const $=');
  assert.ok(a > 0 && b > a && c > b, 'insights-costs, then insights-overview, then the page script');
  assert.match(INS, /if\(window\.HelmPrivacy&&HelmPrivacy\.isHidden&&HelmPrivacy\.isHidden\(\)\)\{ m\.textContent="Show amounts first \(eye button\), then export\."; return; \}/);
  assert.match(INS, /costRes\.value\.events\.length>=500\)\{\s*cut=true; costRes=\(await Promise\.allSettled\(\[BPStore\.insights\.costs\(r\.from,r\.to\)\]\)\)\[0\]/);
  assert.match(INS, /const benchRows=allRows&&bf\?allRows\.filter\(x=>String\(x\.date\|\|""\)>=bf\):allRows;/);
  assert.match(INS, /costsUI\.set\(\{ rows:benchRows\|\|\[\], from:r\.from, to:r\.to \}\)/);
  assert.match(INS, /BPStore\.insights\.costs\(lf,r\.to\)/);
  assert.match(INS, /BPStore\.insights\.overview\(r\.from,r\.to\)/);
  assert.match(CSS, /\.kpis\.io-glance \{ grid-template-columns: repeat\(auto-fit, minmax\(160px, 1fr\)\); \}/);
  assert.match(CSS, /@media \(max-width: 640px\) \{\n  \.kpis\.io-glance \{ grid-template-columns: 1fr 1fr; \}/);
});
t('page tour: Insights has 8 steps, the new cards, money steps for Finance only, no "leads" in the Events step', () => {
  const at = TOURS.indexOf('"insights.html": ['), end = TOURS.indexOf('],', at), blk = TOURS.slice(at, end);
  const steps = blk.match(/\{ sel: "[^"]+"/g) || [];
  assert.equal(steps.length, 8);
  ['#ioGlance', '#ioFunnelCard', '#ioPayCard', '#ioUpCard'].forEach((s) => assert.ok(blk.includes(`sel: "${s}"`), s));
  assert.match(blk, /sel: "#ioPayCard", need: "finance"/); assert.match(blk, /sel: "#moneyKpis", need: "finance"/);
  assert.ok(!/How many leads and events/.test(blk));
});
t('0405: read-only definer function, permission checks, studio scope, no write / table / index / trigger; ASCII', () => {
  assert.match(SQL, /create or replace function public\.insights_overview\(p_from date, p_to date, p_currency text default null\)\nreturns jsonb language plpgsql stable security definer set search_path = ''/);
  assert.match(SQL, /if not public\.has_area\('insights', 'view'\) then raise exception 'not authorized' using errcode = '42501'/);
  ['finance', 'leads', 'quotes'].forEach((a) => assert.ok(SQL.includes(`public.has_area('${a}', 'view')`), a));
  assert.match(SQL, /v_org uuid := public\.current_org_id\(\);/);
  assert.ok(!/\b(insert\s+into|update\s+public\.|delete\s+from|create\s+table|create\s+(unique\s+)?index|create\s+trigger|alter\s+table|drop\s+)/i.test(SQL.replace(/--[^\n]*/g, '')), 'read-only');
  assert.ok(!/[^\x00-\x7f]/.test(SQL) && !/[^\x00-\x7f]/.test(APPLY), 'ASCII');
  assert.match(SQL, /grant execute on function public\.insights_overview\(date, date, text\) to authenticated/);
  assert.match(SQL, /revoke all on function public\._r405_funnel\(uuid, text, date, date, boolean\) from authenticated/);
  assert.ok(/org_id = v_org/.test(SQL) && !/org_id\s*=\s*p_org\b/.test(SQL.slice(SQL.indexOf('function public.insights_overview'))), 'studio scope in the main body');
});
t('APPLY-0405: begins with the lock / statement timeouts, the migration verbatim, check rows, commit; MANIFEST + run-all', () => {
  assert.match(APPLY, /\nbegin;\nset local lock_timeout = '5s';\nset local statement_timeout = '5min';\n/);
  assert.ok(APPLY.includes(SQL), 'migration verbatim');
  assert.match(APPLY, /\) v order by item;\ncommit;\n$/);
  assert.ok(!/create temp|temporary table|^\s*set (session|search_path|role)\b/im.test(APPLY), 'no session state');
  assert.match(MAN, /\nforward  supabase\/migrations\/0405_r240_insights_overview\.sql\n/);
  assert.match(RUN, /run "r240-insights-overview-0405" "R240-INSIGHTS-0405: ALL PASS \\\(20\/20\\\)"/);
  assert.match(RUN, /run "r240-apply-0405" "APPLY-0405: ALL OK"/);
  assert.match(read('supabase/CHECK-PROD-MIGRATIONS.sql'), /'0405_r240_insights_overview', 'fn', 'public', 'insights_overview', 'date,date,text'/);
});
if (fail) { console.log('r240-insights: ' + fail + ' FAILED'); process.exit(1); }
console.log('r240-insights: ok (' + n + ')');
