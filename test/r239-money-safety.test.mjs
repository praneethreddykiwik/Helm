// r239-money-safety.test.mjs - R239 / Phase 3 "Money safety" (0404) shape + page checks, no database.
//  1  0404 + APPLY-0404: additive, ASCII, paste-safe (begin, lock_timeout 5s, statement_timeout 5min, the migration verbatim,
//     12 check rows, commit), no temp table / psql meta / drop table / delete / truncate; MANIFEST lists 0404 after 0402
//     with 0401 / 0403 left to the parallel PRs; run-all runs the DB suite + the APPLY with the test switch documented.
//  2  The payment request key SURVIVES A RELOAD: the moneyKey block of store-api.js (cut out and run) keeps one key per
//     form in sessionStorage until the server answers - a new page (same tab storage) gets the same key back, another
//     amount gets a new one, done() clears it. Settlement + flow payments, milestone marks, vendor payouts, refunds,
//     claims, cost lines, milestones, corrections and TDS all use it.
//  3  Void instead of delete on every page that deleted a money row; Undo paid; credit on account; Freeze now card;
//     voided rows left out of the page totals; amounts carry data-money (Hide amounts); page tours updated.
import { readFileSync, existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n    ' + (e && e.message || e)); } };

const SQL = read('supabase/migrations/0404_r239_money_safety.sql'), APPLY = read('supabase/APPLY-0404.sql'), MAN = read('supabase/migrations/MANIFEST');
const RUNALL = read('scripts/db-test/run-all.sh'), DBT = read('tests/db/r239-money-safety-0404.sql');
const API = read('public/store-api.js'), SET = read('public/settlement.html'), LOG = read('public/logistics.html'), BUD = read('public/budget.html');
const PLAN = read('public/budget-plan.js'), UI = read('public/money-safety-ui.js'), MLK = read('public/money-lock-ui.js'), FLOW = read('public/flow.html');
const VB = read('public/vendor-bills-ui.js'), VRQ = read('public/vendor-requests-ui.js'), TOURS = read('public/page-tours.js'), CSS = read('public/money-lock.css');
const ascii = (s) => /^[\x09\x0a\x0d\x20-\x7e]*$/.test(s);

t('1a 0404 + APPLY-0404 + the DB suite are ASCII; APPLY = header, begin, 5s lock wait, 5 min cap, the migration verbatim, 12 check rows, commit', () => {
  assert.ok(ascii(SQL), '0404 ASCII'); assert.ok(ascii(APPLY), 'APPLY ASCII'); assert.ok(ascii(DBT), 'suite ASCII');
  assert.match(APPLY, /^-- APPLY-0404 /);
  assert.match(APPLY, /\nbegin;\nset local lock_timeout = '5s';\nset local statement_timeout = '5min';\n/);
  assert.ok(APPLY.includes(SQL.trim()), 'the whole migration is in the paste');
  assert.equal((APPLY.match(/^  \('\d\d /gm) || []).length, 12);
  assert.match(APPLY, /\) v\(item, ok\) order by item;\ncommit;\n$/);
});
t('1b paste-safe and additive: no temp table, no psql meta-command, no drop table / delete from / truncate / alter ... drop column', () => {
  for (const [n, s] of [['0404', SQL], ['APPLY', APPLY]]) {
    const code = s.replace(/--[^\n]*/g, '');
    assert.ok(!/\btemp(orary)?\s+table\b/i.test(code), n + ' temp table');
    assert.ok(!/^\s*\\/m.test(code), n + ' psql meta');
    assert.ok(!/\bdrop\s+table\b/i.test(code), n + ' drop table');
    assert.ok(!/\bdelete\s+from\b/i.test(code), n + ' delete');
    assert.ok(!/\btruncate\b/i.test(code), n + ' truncate');
    assert.ok(!/\bdrop\s+column\b/i.test(code), n + ' drop column');
  }
  // the one constraint it re-issues keeps its name and only loosens for reversal rows
  assert.match(SQL, /drop constraint if exists quote_payments_amount_finite_chk;\n\s*alter table public\.quote_payments add constraint quote_payments_amount_finite_chk\n\s*check \(\(\(amount >= 0\) and \(amount < 1000000000000\)\) or \(\(reverses_payment_id is not null\) and \(amount < 0\)/);
  // every new column is nullable without a default (no existing row rewritten)
  for (const m of SQL.matchAll(/add column if not exists (\w+) ([^;]+);/g)) assert.ok(!/default|not null/i.test(m[2]), m[1] + ' must be nullable without default');
});
t('1c MANIFEST: 0404 right after 0403 (0401 belongs to #478, 0405 / 0406 unused); run-all runs the suite + APPLY; test switch documented', () => {
  assert.match(MAN, /\nforward  supabase\/migrations\/0402_r236_ops_health\.sql\n(# 0401 [^\n]+\nforward  supabase\/migrations\/0401_[^\n]+\n)?# 0403 [^\n]+\nforward  supabase\/migrations\/0403_r238_signup_safety\.sql\n# 0404 [^\n]+\nforward  supabase\/migrations\/0404_r239_money_safety\.sql\n/);
  assert.ok(!/forward  supabase\/migrations\/0406_/.test(MAN), '0406 unused');   // R240: 0405 = insights overview (after 0404)
  assert.match(MAN, /0404_r239_money_safety\.sql\n# 0405 [^\n]+\nforward  supabase\/migrations\/0405_r240_insights_overview\.sql/);
  assert.match(RUNALL, /-c helm\.money_void_gate=off -c helm\.retired_role_gate=off -c helm\.r400_remove=off"/);
  assert.match(RUNALL, /run "r239-money-safety-0404" "R239-MONEY-SAFETY-0404: ALL PASS \\\(60\/60\\\)" psql -q -f tests\/db\/r239-money-safety-0404\.sql/);
  assert.match(RUNALL, /run "r239-apply-0404" "APPLY-0404: ALL OK"/);
  assert.match(RUNALL, /run "r239-order-prod-0404" "R239-ORDER-PROD-0404: PASS" bash tests\/db\/r239-order-prod-0404\.sh/);   // the real prod order: 0402, 0403, 0401, then 0404 twice
  assert.match(DBT, /select set_config\('helm\.money_void_gate', 'on', false\);/);
  assert.ok(existsSync(new URL('../supabase/APPLY-0404.sql', import.meta.url)));
});
t('1d the guard: signed-in hard delete refused (Use Void), voided rows never change, the test switch only skips the delete refusal', () => {
  assert.match(SQL, /if not v_api or coalesce\(current_setting\('helm\.money_void_gate', true\), ''\) = 'off' then return old; end if;\n\s*raise exception 'Money entries are never deleted\. Use Void instead/);
  for (const tb of ['event_refunds', 'expense_claims', 'event_costs', 'payment_milestones'])
    assert.ok(SQL.includes(`create trigger zzzzz_r404_money_guard before insert or update or delete on public.${tb} for each row execute function public._r404_tg_money_guard();`), tb);
  assert.match(SQL, /raise exception 'This entry was voided and is kept exactly as it was\.'/);
});

// ---- 2) the key survives a reload: run the moneyKey block of store-api.js against a stub sessionStorage -----------------
function keyBlock(storage, uuids) {
  const a = API.indexOf('const MK_PREFIX = "helm_mk:"'), b = API.indexOf('const msNeeds = ', a);
  assert.ok(a > 0 && b > a, 'moneyKey block found');
  let n = 0;
  const ctx = { global: { sessionStorage: storage }, sessionStorage: storage, crypto: { randomUUID: () => (uuids || 'key') + '-' + (++n) }, Date, JSON, String, Number };
  vm.createContext(ctx);
  vm.runInContext(API.slice(a, b) + '\nthis.moneyKey = moneyKey;', ctx);
  return ctx.moneyKey;
}
function store() { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m }; }
t('2a one key per form, kept in sessionStorage until the server answers: a RELOAD (new page, same tab) sends the same key', () => {
  const ss = store();
  const page1 = keyBlock(ss, 'p1'), k1 = page1.get('settle-pay:q1', 'q1|5000'), k1b = page1.get('settle-pay:q1', 'q1|5000');
  assert.equal(k1b, k1, 'retry click');
  const page2 = keyBlock(ss, 'p2');                                       // the page reloaded after the answer was lost
  assert.equal(page2.get('settle-pay:q1', 'q1|5000'), k1, 'after a reload: the same key, so the server records it once');
  assert.notEqual(page2.get('settle-pay:q1', 'q1|4000'), k1, 'another amount = another payment');
  page2.done('settle-pay:q1');
  assert.equal(page2.peek('settle-pay:q1'), null, 'saved: cleared');
  assert.notEqual(page2.get('settle-pay:q1', 'q1|4000'), k1);
  assert.notEqual(page2.get('settle-pay:q2', 'q1|5000'), page2.get('settle-pay:q3', 'q1|5000'), 'one key per event / form');
});
t('2b a key older than a day is never reused; storage blocked (private mode) still gives a key', () => {
  const ss = store(); const p = keyBlock(ss, 'x'); const k = p.get('f', 's');
  ss.setItem('helm_mk:f', JSON.stringify({ sig: 's', key: k, ts: Date.now() - 25 * 3600 * 1000 }));
  assert.notEqual(p.get('f', 's'), k);
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  const q = keyBlock(broken, 'y'); assert.match(q.get('f', 's'), /^y-/); q.done('f');
});
t('2c every money form uses the key: settlement + flow payments, milestone marks, vendor payouts, refunds, claims, cost lines, milestones, corrections, TDS', () => {
  assert.match(SET, /payScope="settle-pay:"\+id, MK=\(typeof BPStore!=="undefined"&&BPStore\.moneySafety\)\?BPStore\.moneySafety\.key:null;/);
  assert.match(SET, /recordPayment\._idem=null; if\(MK\) MK\.done\(payScope\);/);
  assert.match(FLOW, /payScope="flow-pay:"\+id, MK=\(typeof BPStore!=="undefined"&&BPStore\.moneySafety\)\?BPStore\.moneySafety\.key:null;/);
  assert.match(FLOW, /recordPayment\._idem=null; if\(MK\) MK\.done\(payScope\);/);
  assert.match(API, /const scope = "ms-settle:" \+ id, key = idempotencyKey \|\| moneyKey\.get\(scope, String\(method \|\| "cash"\)\);/);
  assert.match(VB, /var MK = B\.moneySafety && B\.moneySafety\.key, ks = "vb-pay:" \+ b\.id;/);
  assert.match(VRQ, /ks = "vrq-pay:" \+ i\.id; if \(MK\) key = MK\.get\(ks,/);
  assert.match(SET, /BPStore\.expenses\.add\(id,\{ who, description:desc, amount:av\.value \}, key\)/);
  assert.match(SET, /BPStore\.refunds\.add\(id,\{ kind, reason, amount:amt \}, key\)/);
  assert.match(BUD, /BPStore\.budget\.addCost\(id,\{ description:desc, kind, estimated,\n\s*actual \}, key\)/);
  assert.match(LOG, /BPStore\.milestones\.add\(id,\{ label:l, due_date:due, amount:ar\.value \}, key\)/);
  assert.match(MLK, /B\.moneyLock\.addCorrection\(id, cs\.value, n, why, null, ck\)/);
  assert.match(MLK, /B\.moneyLock\.recordTds\(id, n, sec\.value\.trim\(\), d\.default_rate, nt\.value\.trim\(\), tk\)/);
  assert.match(API, /rpc\("money_correction_add_once", \{ p_key: key, \.\.\.a \}\)/);
  assert.match(API, /rpc\("client_tds_record_once", \{ p_key: key, \.\.\.a \}\)/);
  for (const tb of ['payment_milestones', 'event_refunds', 'expense_claims', 'event_costs']) assert.ok(API.includes(`keyedInsert("${tb}", { quote_id: quoteId,`), tb);
});
t('2d a keyed insert answers "already saved" for its own key and still works on a database before 0404', () => {
  const a = API.indexOf('async function keyedInsert('), b = API.indexOf('const moneySafety = {', a); const K = API.slice(a, b);
  assert.match(K, /isNoKeyCol\(r\.error\)\) r = await supa\.from\(table\)\.insert\(row\)/);
  assert.match(K, /isKeyDup\(r\.error\)\) \{\n\s*const g = await supa\.from\(table\)\.select\("\*"\)\.eq\("quote_id", row\.quote_id\)\.eq\("request_key", key\)\.maybeSingle\(\);\n\s*if \(!g\.error && g\.data\) return \{ \.\.\.g\.data, duplicate: true \};/);
  assert.match(API, /const isKeyDup = \(e\) => !!\(e && e\.code === "23505" && \/_r404_request_key_uq\//);
});

// ---- 3) the pages --------------------------------------------------------------------------------------------------------
t('3a no page deletes a money row any more: Void (reason) on refunds, claims, cost lines, milestones', () => {
  for (const [n, s, bad] of [['settlement', SET, /BPStore\.(refunds|expenses)\.remove\(/], ['logistics', LOG, /BPStore\.milestones\.remove\(/], ['budget-plan', PLAN, /budget\.removeCost\(/], ['budget', BUD, /removeCost\(/]])
    assert.ok(!bad.test(s), n + ' still deletes');
  assert.match(SET, /data-evoid="\$\{esc\(e\.id\)\}"/); assert.match(SET, /data-rvoid="\$\{esc\(r\.id\)\}"/);
  assert.match(SET, /voidEntry\(b,"claim",b\.dataset\.evoid,"this expense claim"\)/); assert.match(SET, /voidEntry\(b,"refund",b\.dataset\.rvoid,/);
  assert.match(SET, /BPStore\.moneySafety\.voidEntry\(kind,rowId,why,key\)/);
  assert.match(LOG, /BPStore\.moneySafety\.voidEntry\("milestone",b\.dataset\.mvoid,why,/);
  assert.match(PLAN, /MS\.voidEntry\("cost", k, why, vk\)/);
  assert.match(API, /voidEntry\(kind, id, reason, key\) \{[\s\S]{0,260}if \(r\.length < 5 \|\| r\.length > 500\) return Promise\.reject/);
});
t('3b voided rows are left out of every page total (lists filter them; the history comes from money_voided_list)', () => {
  assert.match(API, /\.from\("payment_milestones"\)\.select\("\*"\)\.eq\("quote_id", quoteId\)\.order\("due_date"\)\.order\("seq"\); if \(error\) throw error; return \(data \|\| \[\]\)\.filter\(\(m\) => !m\.voided_at\);/);
  assert.match(API, /\.from\("event_refunds"\)\.select\("\*"\)\.eq\("quote_id", quoteId\)\.order\("created_at"\);\n\s*if \(error\) throw error; return \(data \|\| \[\]\)\.filter\(\(r\) => !r\.voided_at\);/);
  assert.match(API, /\.from\("expense_claims"\)\.select\("\*"\)\.eq\("quote_id", quoteId\)\.order\("created_at"\); if \(error\) throw error; return \(data \|\| \[\]\)\.filter\(\(e\) => !e\.voided_at\);/);
  assert.match(API, /\.from\("event_costs"\)\.select\("\*"\)\.eq\("quote_id", quoteId\)\.order\("created_at"\); if \(error\) throw error; return \(data \|\| \[\]\)\.filter\(\(c\) => !c\.voided_at\);/);
  assert.match(API, /voided\(quoteId\) \{ return msRead\("money_voided_list"/);
});
t('3c Undo paid (logistics) + Reverse (settlement receipts) add a reversing entry; credit on account on an overpayment; Freeze now', () => {
  assert.match(LOG, /data-mundo="\$\{esc\(m\.id\)\}"/); assert.match(LOG, /BPStore\.moneySafety\.undoPaid\(b\.dataset\.mundo,why,/);
  assert.match(UI, /await M\.reverse\(p\.id, why, key\)/);
  assert.match(SET, /BPStore\.moneySafety\.recordWithCredit\(id, amt, "cash", "Settlement payment", cKey\)/);
  assert.match(UI, /M\.setFreeze\(id, !fr\.frozen, why\)/); assert.match(UI, /M\.applyCredit\(c\.id\)/); assert.match(UI, /M\.refundCredit\(c\.id, why\)/);
  assert.match(SET, /<div data-msf-mount="settlement" id="moneySafety" hidden><\/div>/);
  assert.match(SET, /<script src="money-lock-ui\.js\?v=3"><\/script><script src="money-safety-ui\.js\?v=1"><\/script>/);
  assert.match(SET, /money-lock\.css\?v=2"/);
});
t('3d money-safety-ui.js: DOM only (no innerHTML), every amount data-money (Hide amounts), hidden on a database without 0404', () => {
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(UI));
  assert.match(UI, /function moneyTd\(v, fmt, label, cls\) \{[\s\S]{0,200}c\.appendChild\(money\(el\("span"/);
  assert.match(UI, /sum\.appendChild\(money\(el\("b", null, fmt\(cr\.open_total\)\)\)\)/);
  assert.match(UI, /if \(!fr\) \{ box\.hidden = true; return; \}/);
  assert.match(UI, /if \(!canFin\) \{ box\.hidden = true; return; \}/);
  assert.match(CSS, /\.msf-strike,\.msf-strike span\{text-decoration:line-through/);
});
t('3e page tours: Money safety on Settlement, Void on the Budget plan; store-api exports moneySafety', () => {
  assert.match(TOURS, /\{ sel: "#moneySafety", need: "finance", title: "Money safety", desc: "Nothing here is deleted: Void a wrong entry/);
  assert.match(TOURS, /Void a wrong line: it stays in the history and counts 0\./);
  assert.match(API, /\n    moneySafety, \/\/ R239 \(0404\)\n/);
});

console.log(`\nR239 money safety: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
