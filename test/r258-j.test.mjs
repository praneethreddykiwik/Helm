// R258 (agent J): payment days are suggested, the studio is reminded (0445), "Send reminder to the client" with the words first, "Client says paid",
// the client's "Pay this payment" step. Pure parts + wiring; nothing is sent.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), root = new URL('..', import.meta.url).pathname, read = (p) => readFileSync(root + p, 'utf8');
const PS = require('../public/payment-schedule.js'), PF = require('../public/payment-followup.js'), CP = require('../public/portal-pay.js');
let n = 0; const t = (name, f) => { f(); n++; console.log('  ok', name); };
const part = (label, value, when, days) => ({ label, value, unit: 'percent', when, days: days || '', date: '' });
const four = () => [part('Advance', 25, 'approval'), part('Second', 25, 'before', 30), part('Third', 25, 'before', 15), part('Final', 25, 'event')];
const T = '2026-11-25';   // a Wednesday
const add = (iso, d) => new Date(Date.parse(iso + 'T00:00:00Z') + d * 864e5).toISOString().slice(0, 10);
const dates = (parts, ev) => parts.map((x) => x.when === 'approval' ? T : x.when === 'event' ? ev : x.when === 'before' ? add(ev, -Number(x.days)) : x.date);

t('suggest: spread evenly, first on approval, last on the event day, no Sundays in between, in order', () => {
  for (const ev of ['2026-12-25', '2027-01-31', '2026-12-20', '2027-06-06']) {
    const r = PS.suggestDates(four(), T, ev), d = dates(r.parts, ev);
    assert.equal(d[0], T); assert.equal(d[3], ev); assert.equal(r.note, '');
    for (let i = 1; i < 4; i++) assert.ok(d[i] > d[i - 1], d.join());
    for (const x of d.slice(1, 3)) assert.notEqual(new Date(x + 'T00:00:00Z').getUTCDay(), 0, x);
    assert.ok(PS.checkParts(r.parts, 400000, T).ok);
    assert.deepEqual(PS.cleanLines(PS.partLines(r.parts, 400000, T, ev)).ok, true);
  }
});
t('suggest: a plan that ends before the event ends the day before (not on a Sunday)', () => {
  const two = () => [part('Advance', 50, 'approval'), part('Balance', 50, 'before', 7)];
  assert.equal(dates(PS.suggestDates(two(), T, '2026-12-24').parts, '2026-12-24')[1], '2026-12-23');
  assert.equal(dates(PS.suggestDates(two(), T, '2026-12-21').parts, '2026-12-21')[1], '2026-12-19');   // Sun 20 -> Sat 19
});
t('suggest: a close event is squeezed, one day apart, and says so; never in the past; too close shares days', () => {
  let r = PS.suggestDates(four(), T, '2026-11-29'), d = dates(r.parts, '2026-11-29');
  assert.deepEqual(d.length, 4); for (let i = 1; i < 4; i++) assert.ok(d[i] > d[i - 1], d.join()); assert.match(r.note, /in 4 days.*only 1 day apart/);
  r = PS.suggestDates(four(), T, '2026-11-26'); d = dates(r.parts, '2026-11-26'); assert.deepEqual(d, [T, '2026-11-26', '2026-11-26', '2026-11-26']); assert.match(r.note, /tomorrow.*share a day/);
  r = PS.suggestDates(four(), T, T); assert.ok(dates(r.parts, T).every((x) => x === T)); assert.match(r.note, /today/);
});
t('suggest: no event date / a past one / one payment: nothing is moved, it says why', () => {
  const p = four(); assert.deepEqual(PS.suggestDates(p, T, null).parts, p); assert.match(PS.suggestDates(p, T, null).note, /event date first/);
  assert.deepEqual(PS.suggestDates(p, T, '2026-11-01').parts, p); assert.match(PS.suggestDates(p, T, '2026-11-01').note, /passed/);
  assert.equal(PS.suggestDates([part('All', 100, 'before', 5)], T, '2026-12-25').parts[0].when, 'approval');
  const far = PS.suggestDates(four(), T, '2028-12-25'); assert.ok(far.parts.every((x) => x.when !== 'before' || Number(x.days) <= 365));
});
t('suggest keeps names, percents and the plan itself (the array given is not changed)', () => {
  const p = four(), copy = JSON.stringify(p), r = PS.suggestDates(p, T, '2026-12-25'); assert.equal(JSON.stringify(p), copy);
  assert.deepEqual(r.parts.map((x) => [x.label, x.value, x.unit]), p.map((x) => [x.label, x.value, x.unit]));
});
t('the real date beside every row', () => {
  assert.equal(PS.dateLine(part('a', 10, 'before', 10), '2026-11-15', T), '10 days before = Sun 15 Nov');
  assert.equal(PS.dateLine(part('a', 10, 'before', 1), '2027-01-04', T), '1 day before = Mon 4 Jan 2027');
  assert.equal(PS.dateLine(part('a', 10, 'event'), '2026-12-25', T), 'Event day = Fri 25 Dec');
  assert.equal(PS.dateLine(part('a', 10, 'approval'), T, T), 'If approved today = Wed 25 Nov');
  assert.equal(PS.dateLine(part('a', 10, 'before', 3), null, T), 'Set the event date first');
});

const rows = [{ id: 'm1', label: 'Advance (30%)', state: 'paid', remaining: 0, days: -20 }, { id: 'm2', label: 'Second payment (50%)', state: 'overdue', remaining: 50000, amount: 115080, days: -3, due_date: '2026-11-22' }, { id: 'm3', label: 'Final (20%)', state: 'due', remaining: 46000, days: 30, due_date: '2026-12-25' }];
t('the compact Payments line: next payment, what is left, state; claim wins; held says after approval', () => {
  let m = PF.lineModel({ rows }, { rows: {} }); assert.deepEqual([m.id, m.label, m.left, m.chip.text, m.more], ['m2', 'Second payment', 50000, 'Overdue 3 days', 1]);
  m = PF.lineModel({ rows }, { rows: { m3: { claim: { id: 'c' } } } }); assert.equal(m.chip.text, 'Client says paid');
  assert.equal(PF.lineModel({ rows }, { rows: {}, held: true }).chip.text, 'After approval');
  assert.equal(PF.lineModel({ rows }, null).chip.text, 'Overdue 3 days');
  assert.equal(PF.lineModel({ rows: [rows[0]] }, null), null); assert.equal(PF.lineModel(null, null), null);
  assert.equal(PF.stateOf({ state: 'due', days: 5 }, { reminder: { status: 'sent' } }).text, 'Reminder sent'); assert.equal(PF.stateOf({ state: 'due', days: 0 }, null).text, 'Due today');
});
t('buttons: the next one, the late / due ones and a claimed one only', () => {
  assert.deepEqual(PF.active({ rows }, { rows: {} }), ['m2']); assert.deepEqual(PF.active({ rows }, { rows: { m3: { claim: {} } } }), ['m2', 'm3']);
  assert.deepEqual(PF.active({ rows: rows.slice(2) }, null), ['m3']);
});
t('"Reminder sent 25 Nov 10:12 by Ananya" (studio time), and the truth when it was not', () => {
  const r = { at: '2026-11-25T04:42:00Z', by: 'Ananya', status: 'sent' };
  assert.equal(PF.reminderText(r, 'Asia/Kolkata'), 'Reminder sent 25 Nov 10:12 by Ananya');
  assert.equal(PF.reminderText({ ...r, status: 'pending' }, 'Asia/Kolkata'), 'Reminder on its way, asked 25 Nov 10:12 by Ananya');
  assert.equal(PF.reminderText({ ...r, status: 'skipped' }, 'Asia/Kolkata'), 'Reminder not sent, asked 25 Nov 10:12 by Ananya'); assert.equal(PF.reminderText(null), '');
  assert.match(PF.claimText({ amount: 5, method: 'upi', reference: '43', at: r.at, code: false }, (x) => 'Rs ' + x, 'Asia/Kolkata'), /^Client says paid: Rs 5 by UPI, reference 43, 25 Nov 10:12\. Not confirmed with a code\.$/);
});
t('record: amount + reference handed to the form (this tab, 2 hours); the note only for that amount', () => {
  const store = {}; globalThis.sessionStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; }, removeItem: (k) => { delete store[k]; } };
  PF.putPrefill('q1', { id: 'c1', amount: 115080, method: 'upi', reference: 'UTR 9' });
  assert.equal(PF.prefill('q1').amount, 115080); assert.equal(PF.prefill('q2'), null); assert.equal(PF.prefill('q1', Date.now() + 7300000), null);
  assert.equal(PF.refNote('q1', 115080), 'Client paid by UPI, reference UTR 9'); assert.equal(PF.refNote('q1', 100), null); PF.clearPrefill('q1'); assert.equal(PF.refNote('q1', 115080), null);
  delete globalThis.sessionStorage;
});

t('client step: model shows only what the server answers; nothing = nothing', () => {
  assert.equal(CP.model(null), null); assert.equal(CP.model({ on: false, rows: [{}] }), null); assert.equal(CP.model({ on: true, rows: [] }), null);
  const m = CP.model({ on: true, today: T, rows: [{ id: 'm2', label: 'Second payment (50%)', left: 50000, amount: 115080, due_date: '2026-11-20' }, { id: 'x', left: 0 }], channels: { email: 'r***@x.com' }, code: true, pay: { upi: 'a@b' } });
  assert.equal(m.rows.length, 1); assert.deepEqual([m.rows[0].name, m.rows[0].late, m.code], ['Second payment', true, true]); assert.deepEqual(m.channels, [['email', 'r***@x.com']]);
});
t('client step: what was paid is checked before it is sent', () => {
  assert.equal(CP.checkClaim({ amount: '1,15,080', method: 'upi', reference: '1' }, 115080).amount, 115080);
  assert.match(CP.checkClaim({ amount: '0', method: 'upi', reference: '1' }, 10).error, /amount/); assert.match(CP.checkClaim({ amount: '50', method: 'upi', reference: '1' }, 10).error, /more than/);
  assert.match(CP.checkClaim({ amount: '5', method: 'bank', reference: ' ' }, 10).error, /reference/); assert.ok(CP.checkClaim({ amount: '5', method: 'cash' }, 10).ok); assert.equal(CP.checkClaim({ amount: 'x', method: 'cash' }, 10).ok, false);
});

const SQL = read('supabase/migrations/0445_r258_payment_followup.sql'), APPLY = read('supabase/APPLY-0445.sql'), STORE = read('public/store-api.js'), OTP = read('supabase/functions/send-otp/index.ts');
t('0445: additive (no drop / delete / truncate of data), ASCII, APPLY = the same file in one transaction, in the MANIFEST after 0443', () => {
  assert.ok(!/^\s*(drop|delete|truncate)\b/im.test(SQL)); assert.ok(!/[^\x00-\x7f]/.test(SQL)); assert.ok(!/create temp|set_config\(|\bset session\b/i.test(SQL));
  assert.ok(APPLY.includes(SQL)); assert.match(APPLY, /\nbegin;\n[\s\S]*\ncommit;\n$/);
  const man = read('supabase/migrations/MANIFEST'); assert.ok(man.indexOf('0445_r258') > man.indexOf('0443_r257'));
});
t('0445: money is never written by the client step; approvals and consents are never touched', () => {
  assert.ok(!/(insert into|update) public\.(quote_payments|payment_milestones|quotes|quote_otps|quote_consents)\b/.test(SQL));
  for (const f of ['public_payment_steps', 'public_payment_code_verify', 'public_payment_claim']) { const b = SQL.slice(SQL.indexOf('function public.' + f)); assert.ok(b.slice(0, 1400).includes('perform public.public_get_quote(p_token)'), f); assert.ok(b.slice(0, 1400).includes('_r341_limit'), f); }
});
t('send-otp: payment codes have their own channels (an older send-otp refuses them and stores nothing), never admin_store_otp, never logged', () => {
  const f = OTP.slice(OTP.indexOf('async function sendPaymentCode'), OTP.indexOf('// DB error')); assert.ok(f.length > 500);
  assert.ok(!/admin_store_otp|wa_otp_begin|otp_send_authorize/.test(f)); assert.match(f, /payment_code_begin/); assert.ok(!/L\.\w+\([^)]*\bcode\b[,)]/.test(f.replace(/errTag|bErr\?\.code/g, '')));
  assert.match(STORE, /channel === "whatsapp" \? "pay_whatsapp" : "pay_email"/); assert.match(STORE, /er\.noCode = true/);
});
t('the bell opens the payment card of the event; the same link in the e-mail sender', () => {
  const line = '(k === "payment_followup" || k === "payment_claimed") return "event.html?id=" + enc(q) + "#paySchedCard"';
  assert.ok(STORE.includes(line)); assert.ok(read('supabase/functions/comms-dispatch/deeplink.js').includes(line));
});
t('pages load the new files in the right order; hidden until the server answers; no HTML strings, no inline style', () => {
  for (const p of ['event', 'flow', 'budget']) { const h = read('public/' + p + '.html'); assert.ok(h.indexOf('payment-followup.js') > 0 && h.indexOf('payment-followup.js') < h.indexOf('payment-schedule.js?v='), p); }
  assert.match(read('public/event.html'), /id="payLine" hidden/); assert.match(read('public/portal.html'), /id="payStep" hidden/);
  const a = read('public/approve.html'); assert.ok(a.indexOf('portal-pay.js') < a.indexOf('approve-plan.js?v='));
  for (const f of ['payment-followup.js', 'portal-pay.js']) { const s = read('public/' + f); assert.ok(!/innerHTML|insertAdjacentHTML|\.style\b|setAttribute\("style"/.test(s), f); assert.ok(!/—/.test(s), f + ': em dash'); }
  assert.match(read('scripts/client-api.template.js'), /members paySchedule: publicGet, publicSteps, payCodeSend, payCodeVerify, payClaim@@/);
});
console.log('R258-J: ALL PASS (' + n + ')');
