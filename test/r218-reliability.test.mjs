// r218-reliability.test.mjs - audit C (reliability, 18 Nov 2026).
//  1  Names: the sign-up page (login.html) and the shared form rules (form-validate.js) accept names written in Indian
//     scripts (vowel signs / virama = Unicode marks), the joiners some keyboards type (U+200C / U+200D) and initials with
//     a full stop ("K. Srinivas"); still refuse digits, symbols, doubled punctuation.
//  2  Payments: a RETRY click of the same advance / settlement payment re-sends the SAME idempotency key (a lost answer
//     may mean the payment was saved - the server then returns the same receipt), and a NEW payment after a success gets
//     a new key. Driven through the real page code (the key block is cut out of flow.html / settlement.html and run).
//  3  0390: the vendor-payment same-key lock is in the migration and in APPLY-0390, ASCII only, listed in MANIFEST.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const require = createRequire(import.meta.url);
let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n    ' + (e && e.message || e)); } };

const GOOD = ['Praneeth Reddy', 'రాము కుమార్', 'प्रिया शर्मा', 'அருண்', 'অনির্বাণ', 'ਗੁਰਪ੍ਰੀਤ', 'K. Srinivas', 'Ravi K.',
  'അന്‍വര്‍', 'सत्‌यम', "D'Souza", 'Mary-Ann', 'Rāmū'];
const BAD = ['R2D2', 'a@b', 'K..Srinivas', 'Ravi .K', "--Ravi", 'Ravi--K', '<b>x</b>y1', '‍Ravi'];

t('login.html sign-up name rule: Indian scripts + initials accepted, junk refused', () => {
  const L = read('public/login.html');
  const re = eval(/const NAME_RE=(\/.*\/u);/.exec(L)[1]);
  const prob = /if\(!NAME_RE\.test\(n\)\|\|(\/[^\n]*?\/)\.test\(n\)\)/.exec(L);
  assert.ok(prob, 'doubled-punctuation check present');
  const dbl = eval(prob[1]);
  const ok = (s) => re.test(s) && !dbl.test(s);
  for (const s of GOOD) assert.ok(ok(s), 'should accept ' + JSON.stringify(s));
  for (const s of BAD) assert.ok(!ok(s), 'should refuse ' + JSON.stringify(s));
});

t('form-validate.js name rule (profile / emergency contact): same cases', () => {
  const V = require('../public/form-validate.js');
  for (const s of GOOD) assert.ok(V.rules.name(s, { required: true }).ok, 'should accept ' + JSON.stringify(s));
  for (const s of BAD) assert.ok(!V.rules.name(s, { required: true }).ok, 'should refuse ' + JSON.stringify(s));
  assert.match(V.rules.name('R2D2').error, /full stops/);
});

t('flow.html advance: a retry click re-sends the same key; a success clears it; another amount = a new key', () => {
  const S = read('public/flow.html');
  assert.match(S, /BPStore\.milestones\.record\([^\n]*idem\);\n\s*recordPayment\._idem=null;/, 'cleared right after a saved payment');
  // the same recordPayment object on every click, as on the page
  const rp = function () {};
  const crypto = { randomUUID: (() => { let n = 0; return () => 'uuid-' + (++n); })() };
  const S2 = S.slice(S.indexOf('const paySig='), S.indexOf('const idem=recordPayment._idem.key;') + 'const idem=recordPayment._idem.key;'.length);
  const click = new Function('recordPayment', 'crypto', '$', 'id', 'amount', 'method', S2 + '\nreturn idem;');
  const $ = () => ({ value: 'R-1 ' });
  const k1 = click(rp, crypto, $, 'q1', 50000, 'cash');
  const k2 = click(rp, crypto, $, 'q1', 50000, 'cash');            // answer lost -> retry
  assert.equal(k2, k1, 'retry reuses the key');
  const k3 = click(rp, crypto, $, 'q1', 40000, 'cash');            // a different amount = a different payment
  assert.notEqual(k3, k1);
  rp._idem = null;                                                  // what the page does after a saved payment
  const k4 = click(rp, crypto, $, 'q1', 40000, 'cash');
  assert.notEqual(k4, k3, 'after a success the next payment gets a new key');
});

t('settlement.html payment: a retry click re-sends the same key; a success clears it', () => {
  const S = read('public/settlement.html');
  const a = S.indexOf('const paySig='), endTok = 'const idemKey=recordPayment._idem.key;', b = S.indexOf(endTok, a) + endTok.length;
  assert.ok(a > 0 && b > a);
  assert.match(S, /recordSettlement\([^\n]*idemKey\);\n\s*recordPayment\._idem=null;/);
  const click = new Function('recordPayment', 'self', 'crypto', 'id', 'amt', S.slice(a, b) + '\nreturn idemKey;');
  const crypto = { randomUUID: (() => { let n = 0; return () => 's-' + (++n); })() };
  const rp = function () {};
  const k1 = click(rp, { crypto }, crypto, 'q1', 1000), k2 = click(rp, { crypto }, crypto, 'q1', 1000);
  assert.equal(k2, k1);
  rp._idem = null;
  assert.notEqual(click(rp, { crypto }, crypto, 'q1', 1000), k1);
});

t('0390 + APPLY-0390: same-key lock in both payment functions, ASCII only, in MANIFEST, checks at the end', () => {
  const M = read('supabase/migrations/0390_r218_vendor_pay_same_key.sql'), A = read('supabase/APPLY-0390.sql');
  for (const s of [M, A]) {
    assert.ok(!/[^\x00-\x7F]/.test(s), 'ASCII only');
    assert.match(s, /pg_advisory_xact_lock\(hashtextextended\(''helm:vpay:''/);
    assert.match(s, /vendor_bill_pay\(uuid,numeric,numeric,text,date,text,text,text\)/);
    assert.match(s, /record_vendor_payout__pre0156\(uuid,numeric,date,text,text,text\)/);
    assert.ok(!/^ *--.*'/m.test(s), 'editor-safe: no apostrophes in comment lines');
    assert.ok(!/\b(drop|delete|truncate)\b/i.test(s.replace(/--[^\n]*/g, '')), 'nothing dropped / deleted');
  }
  assert.match(A, /^begin;$/m); assert.match(A, /select item, ok from \(values/); assert.match(A, /^commit;$/m);
  assert.match(read('supabase/migrations/MANIFEST'), /^forward\s+supabase\/migrations\/0390_r218_vendor_pay_same_key\.sql$/m);
});

console.log(`r218-reliability: ${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
