// r246-p9-data-model.test.mjs - R246 fix plan Phase 9, no database:
//   Q-07 India tax parts to paise + a Round-off line that makes the lines add up to the STORED total (display only),
//   Q-08 the browser default rate per country mirrors helm_country_default_gst (0423),
//   Q-16 the quote form's optional Last day + the list reads (only after update 0424), the calendar span,
//   migrations 0423-0425 + APPLY files: paste-safe, additive, D8 pricing functions never re-issued; wiring.
// The database side: tests/db/r246-p9-data-model-0423-0425.sql (pricing differential IN / AE / US).
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const rd = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name); };

const src = rd('public/store-api.js');
const ti = src.indexOf('BPStore.tax = (function () {'); const te = src.indexOf('})();', ti) + 5;
const ctx = { BPStore: { countries: () => [] } };
vm.runInNewContext(src.slice(ti, te), ctx);
const T = ctx.BPStore.tax;
const J = (x) => JSON.parse(JSON.stringify(x));
const IN = T.resolve({}), INTER = { placeOfSupply: 'inter' };
// the canonical money core (same as the server's helm_quote_total for these inputs)
const total = (taxed, rate) => Math.round(taxed + taxed * rate / 100);
const cents = (x) => Math.round(x * 100);

t('Q-07: each half of the tax rounded to paise on its own; Round-off brings the lines to the stored total exactly', () => {
  // 79443 GST: halves 39721.50 + 39721.50 (B28 showed 39722 + 39721)
  const r = J(T.rows({ totalGst: 79443, subtotal: 441350, discount: 0, total: 520793 }, {}, IN));
  assert.deepEqual(r.map((x) => [x.label, x.amount, x.text]), [['CGST', 39721.5, '₹39,721.50'], ['SGST', 39721.5, '₹39,721.50']]);
  // fractional GST: 18% of 12345.67 = 2222.2206 -> 1111.11 each; total 14568 -> round-off +0.10
  const g = 12345.67 * 0.18, rr = J(T.rows({ totalGst: g, subtotal: 12345.67, discount: 0, total: total(12345.67, 18) }, {}, IN));
  assert.deepEqual(rr.map((x) => x.label), ['CGST', 'SGST', 'Round-off']);
  assert.equal(rr[0].amount, 1111.11); assert.equal(rr[2].text, '+ ₹0.11');
  assert.equal(cents(12345.67) + cents(rr[0].amount) + cents(rr[1].amount) + cents(rr[2].amount), cents(14568));
});
t('Q-07: for 2000 random India quotes (intra + inter, discounts) the shown lines add up to the stored total to the paisa; |round-off| < 1', () => {
  let seed = 246; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < 2000; i++) {
    const sub = Math.round(rnd() * 5e6) / (rnd() < 0.5 ? 1 : 100), disc = rnd() < 0.3 ? Math.round(rnd() * sub) / 3 : 0;
    const rate = [18, 5, 12, 28, 0][i % 5], taxed = Math.max(0, sub - disc), gst = taxed * rate / 100, tot = total(taxed, rate);
    const r = J(T.rows({ totalGst: gst, subtotal: sub, discount: disc, total: tot }, i % 2 ? INTER : {}, T.resolve({ gstPct: rate })));
    const shown = cents(T.r2(taxed)) + r.reduce((a, x) => a + cents(x.amount), 0);
    assert.equal(shown, cents(tot), JSON.stringify({ sub, disc, rate, r }));
    r.forEach((x) => { assert.equal(cents(x.amount), Math.round(x.amount * 100)); if (x.roundOff) assert.ok(Math.abs(x.amount) < 1); });
    if (i % 2 === 0 && rate) assert.equal(r[0].amount, r[1].amount);   // CGST = SGST, never a rupee apart
  }
});
t('Q-07: display only - no total in, no Round-off; non-India unchanged; exempt unchanged; old 450 / 450 case unchanged', () => {
  assert.deepEqual(J(T.rows({ totalGst: 900 }, {}, IN)).map((x) => [x.label, x.pct, x.amount]), [['CGST', 9, 450], ['SGST', 9, 450]]);
  const ae = J(T.rows({ gst: 50, subtotal: 1000, total: 1050 }, {}, T.resolve({ taxCountry: 'AE' })));
  assert.deepEqual(ae.map((x) => [x.label, x.amount, x.text]), [['VAT', 50, undefined]]);
  assert.deepEqual(J(T.rows({ gst: 0, total: 1000, subtotal: 1000 }, { taxExempt: true }, IN)).map((x) => x.label), ['GST (exempt)']);
  // a breakdown that does not belong to its total (|difference| >= 1) never prints a misleading Round-off
  assert.deepEqual(J(T.rows({ totalGst: 180, subtotal: 1000, total: 5000 }, {}, IN)).map((x) => x.label), ['CGST', 'SGST']);
  assert.equal(T.paise(-0.4), '− ₹0.40');
});
t('Q-07: every India screen uses the same rule (quote modal + download, approve, proposal view, booklet); the total is the stored one', () => {
  const q = rd('public/quotes.html'), ap = rd('public/approve.html'), pv = rd('public/proposal-view.html'), bk = rd('public/booklet.js');
  assert.match(q, /BPStore\.tax\.rows\(Object\.assign\(\{\}, t, \{ total:grand \}\), p, qTax\)/);
  assert.match(q, /r\.text\?esc\(r\.text\):inr\(r\.amount\)/);
  assert.match(ap, /BPStore\.tax\.rows\(\{ totalGst:g, subtotal:Math\.round\(c\.subtotal\|\|0\), discount:Math\.round\(c\.discount\|\|0\), total:Number\(p\.total\) \}/);
  assert.match(pv, /BPStore\.tax\.rows\(\{ totalGst:c\._gst, subtotal:c\.subtotal, discount:c\.discount\|\|0, total:\+pr\.total \}/);
  assert.match(bk, /label: "Round-off", detail: "", amount: ro, paise: true, kind: "roundoff"/);
  assert.ok(!/pricing\.total\s*=|total\s*=\s*ro/.test(bk));
  assert.match(rd('public/client-api.js'), /label: "Round-off", pct: 0, amount: ro/);   // client pages get the same rule (generated)
});
t('Q-08: browser default = helm_country_default_gst: UAE 5, US 0, override first; India / none / other 18; breakdown uses it', () => {
  assert.equal(T.defaultGst('AE'), 5); assert.equal(T.defaultGst('us'), 0); assert.equal(T.defaultGst('AE', 7.5), 7.5);
  assert.equal(T.defaultGst('AE', 101), 5); assert.equal(T.defaultGst('IN', 5), 18); assert.equal(T.defaultGst(null), 18); assert.equal(T.defaultGst('GB'), 18);
  assert.match(src, /rates\.gstPct!=null\?rates\.gstPct:\(\(BPStore\.tax&&BPStore\.tax\.defaultGst\)\?BPStore\.tax\.defaultGst\(rates\.taxCountry, rates\.taxRateOverride\):18\)/);
});
t('Q-16: last day field (only after 0424), validated, saved with the date; list reads name the column only after 0424; calendar span', () => {
  const q = rd('public/quotes.html');
  assert.match(q, /id="endFld" hidden><label for="c_endDate">Last day/);
  assert.match(q, /BPStore\.schema\.has\(424\)\)===true\) \$\("#endFld"\)\.hidden=false/);
  assert.match(q, /The last day can't be before the event date\./); assert.match(q, /An event can run at most 60 days\./);
  assert.match(q, /updateMeta\(cmId, \{ eventEndDate: \$\("#c_endDate"\)\.value \|\| null \}\)/);
  assert.match(src, /const quoteEndCols = async \(\) => \{ try \{ return \(BPStore\.schema && \(await BPStore\.schema\.has\(424\)\) === true\) \? ",event_end_date" : ""/);
  assert.match(src, /QUOTE_LIST_COLS \+ endCols \+/); assert.match(src, /QUOTE_PAGE_COLS \+ endCols \+/);
  assert.match(src, /eventEndDate: q\.event_end_date \|\| null/);
  assert.match(src, /if \(patch\.eventEndDate !== undefined\) upd\.event_end_date = patch\.eventEndDate \|\| null;/);
  assert.match(rd('public/calendar.html'), /const end=e\.eventEndDate\|\|e\.endDate\|\|null;/);
  assert.match(rd('public/page-tours.js'), /a multi-day event shows on every day from its first to its last day/);
});
const MIG = {}; for (const [k, f] of [['0423', '0423_r246_tax_default_country'], ['0424', '0424_r246_event_end_date'], ['0425', '0425_r246_text_len_checks']]) MIG[k] = rd('supabase/migrations/' + f + '.sql');
t('migrations: additive + idempotent, D8 pricing functions never re-issued, definers pin search_path, NOT VALID only', () => {
  for (const [k, s] of Object.entries(MIG)) {
    const code = s.replace(/--[^\n]*/g, '');
    assert.ok(!/\b(drop\s+(table|column|function)|truncate|delete\s+from|alter\s+table\s+\S+\s+drop\s+column)\b/i.test(code), k + ' destructive');
    assert.ok(!/create\s+or\s+replace\s+function\s+public\.(helm_quote_total|helm_quote_total__pretax|helm_quote_total__base|helm_quote_total_canonical|enforce_pricing_total)\s*\(/i.test(code), k + ' D8 re-issued');
    for (const m of code.matchAll(/create or replace function[\s\S]*?\$(fn)?\$/gi)) if (/security definer/i.test(m[0])) assert.match(m[0], /set search_path = ''/, k);
    assert.match(code, /helm_schema_markers\(num, name\) values \(4\d\d, '0\d{3}_r246_/);
  }
  assert.match(MIG['0424'], /add column if not exists event_end_date date;/); assert.match(MIG['0424'], /\) not valid;/);
  assert.match(MIG['0424'], /rename to _r21_cost_lines__pre0424/);
  assert.match(MIG['0425'], /check \(%I is null or char_length\(%I\) <= %s\) not valid/);
  assert.match(MIG['0425'], /if n > 0 then[\s\S]*?continue;/);   // a column with a longer stored row gets no limit
});
t('APPLY-0423..0425: begin + lock_timeout 5s + statement_timeout 5min, the migration verbatim, ONE check grid, commit, ASCII, no temp tables', () => {
  for (const k of Object.keys(MIG)) {
    const a = rd('supabase/APPLY-' + k + '.sql');
    assert.match(a, /\nbegin;\nset local lock_timeout = '5s';\nset local statement_timeout = '5min';\n/);
    assert.ok(a.includes(MIG[k]), k + ' verbatim'); assert.match(a, /\ncommit;\n$/);
    assert.equal((a.match(/^select item, ok, note from \(values/gm) || []).length, 1);
    assert.ok(!/[^\x00-\x7f]/.test(a), k + ' ascii'); assert.ok(!/create temp|\\i |\\set /i.test(a), k);
  }
});
t('wiring: MANIFEST order, checker overrides paste-safe, CHECK-PROD, release lists, run-all, package', () => {
  const MF = rd('supabase/migrations/MANIFEST'), OV = JSON.parse(rd('supabase/check-prod-overrides.json')), CHK = rd('supabase/CHECK-PROD-MIGRATIONS.sql');
  const nums = [...MF.matchAll(/^forward  supabase\/migrations\/(\d{4})_/gm)].map((m) => m[1]);
  const i = nums.indexOf('0415'); assert.deepEqual(nums.slice(i, i + 4), ['0415', '0423', '0424', '0425']);   // R245: 0413-0415 sit between 0412 and 0423
  for (const k of Object.keys(MIG)) {
    assert.ok(OV[k] && OV[k].note && !/;|\binto\s+[a-z_]/i.test(OV[k].note), k + ' override');
    assert.match(CHK, new RegExp(`\\('${k}_r246_[a-z_]+', `));
  }
  for (const f of ['test/release-1019.test.mjs', 'test/release-1020.test.mjs']) assert.match(rd(f), /'0415', '0423', '0424', '0425'[,\]]/);   // R245: 0413-0415 come before
  const RA = rd('scripts/db-test/run-all.sh');
  assert.match(RA, /run "r246-p9-data-model-0423-0425" "R246-P9-DATA-0423-0425: ALL PASS \\\(32\/32\\\)"/);
  assert.match(RA, /run "r246-apply-0423-0425" "APPLY-0423-0425: ALL OK"/);
  assert.match(JSON.parse(rd('package.json')).scripts.test, /node test\/r246-p9-data-model\.test\.mjs/);
});
console.log(`r246-p9-data-model: ${n} passed`);
