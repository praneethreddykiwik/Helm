// R190 (0373): Money phase 2 "Finish vendor bills" - due reminders (office bell + e-mail, optional vendor note OFF by
// default), TDS off the payout as its own payout row + TDS report, typed advances -> payout rows (added only, never counted
// twice), GST 150-day + cash warnings, bill photo added later, late bills after close, Business "Vendor bills to pay".
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); } };

const MIG = read('supabase/migrations/0373_r190_vendor_bills_finish.sql');
const APPLY = read('supabase/APPLY-0373.sql');
const MF = read('supabase/migrations/MANIFEST');
const RUNALL = read('scripts/db-test/run-all.sh');
const RET = read('tests/db/trial-retention-0184.sql');
const DBT = read('tests/db/r190-vendor-bills-0373.sql');
const OVR = read('supabase/check-prod-overrides.json');
const API = read('public/store-api.js');
const UI = read('public/vendor-bills-ui.js'), CSS = read('public/vendor-bills.css');
const SET = read('public/settlement.html'), BIZ = read('public/business.html');
const TOURS = read('public/page-tours.js');
const IDX = read('supabase/functions/comms-dispatch/index.ts');
const RT = await import('../supabase/functions/_shared/reply-to.mjs');
const M = await import('../supabase/functions/comms-dispatch/vendor-bill-reminder.mjs');
const PKG = read('package.json');
const code = (s) => s.replace(/^\s*--.*$/gm, '');
const ORIGIN = 'https://www.helm.events';
const Q = 'a0000000-0000-4000-8000-00000000da01';

await t('0373: additive, ASCII, no apostrophe in a comment line, never deletes or edits existing money rows', () => {
  assert.ok(/^[\x00-\x7f]*$/.test(MIG), 'ASCII only');
  assert.ok(!MIG.split('\n').some((l) => /^\s*--/.test(l) && l.includes("'")), 'no apostrophe in a comment line');
  assert.doesNotMatch(code(MIG), /\bdrop\s+(table|function|policy|index|column|schema)\b|\bdelete\s+from\b|\btruncate\b/i);
  // the only rows it ever updates are its own new tables (reminder recipients, the mail queue)
  for (const m of code(MIG).matchAll(/\bupdate\s+public\.([a-z_]+)/gi)) assert.ok(['vendor_bill_reminders', 'vendor_bill_mail_outbox'].includes(m[1]), m[1]);
  assert.doesNotMatch(code(MIG), /update\s+public\.vendor_(payouts|bills)\b/i);
  // the one dropped trigger is its own (re-run safe)
  for (const m of code(MIG).matchAll(/drop trigger if exists (\w+) on public\.(\w+)/gi)) assert.equal(m[1], 'ad_r373_advance_lock');
  // vendor_payouts only gets nullable new columns
  for (const m of code(MIG).matchAll(/alter table public\.vendor_payouts add column if not exists (\w+) (\w+)([^;]*);/gi)) {
    assert.ok(['source', 'tds_section', 'payout_ref'].includes(m[1]), m[1]); assert.doesNotMatch(m[3], /not null|default/i, m[1] + ' stays nullable, no default');
  }
  assert.doesNotMatch(MIG, /payout_ref uuid references/i, 'no foreign key on immutable payouts (a cascade would try to update them)');
});

await t('0373: every function SECURITY DEFINER (or pure) with a fixed empty search_path; wraps keep the old bodies once', () => {
  for (const m of MIG.matchAll(/create or replace function (public\.[a-z0-9_]+)\([^]*?\)\s*returns[^]*?as \$(fn)?\$/g)) {
    assert.match(m[0], /set search_path = ''/, m[1] + ' fixed search_path');
    if (!/_r373_slot|_r373_money/.test(m[1])) assert.match(m[0], /security definer/, m[1] + ' security definer');
  }
  for (const f of ['_r21_cost_lines', '_r23_visible', 'bell_feed']) {
    assert.ok(MIG.includes("rename to " + f + "__pre0373"), f + ' kept once');
    assert.ok(MIG.includes("position('r190-0373' in coalesce(v_src, '')) = 0 and to_regprocedure('public." + f + "__pre0373("), f + ' renamed only once');
  }
  // the wrappers name the markers of the bodies they keep (r23-crew-0265 / r186-0369 checks still hold)
  for (const mk of ['r21-money-0246', 'r22-money-0252', 'r23-crew-0265', 'r186-0369', 'r24-ci-0270', 'r163-0357']) assert.ok(MIG.includes(mk), mk);
});

await t('0373: tables closed to the app (RLS on + forced, no grants), studio guards, one reminder per bill and slot', () => {
  for (const tb of ['vendor_bill_settings', 'vendor_bill_files', 'vendor_bill_late', 'vendor_bill_reminders', 'vendor_bill_mail_outbox'])
    assert.match(MIG, new RegExp('create table if not exists public\\.' + tb + ' \\('), tb);
  assert.match(MIG, /execute format\('alter table public\.%I force row level security', t\)/);
  assert.match(MIG, /execute format\('revoke all on table public\.%I from authenticated', t\)/);
  assert.match(MIG, /create unique index if not exists vendor_bill_reminders_once373 on public\.vendor_bill_reminders \(bill_id, slot\)/);
  assert.match(MIG, /tgname = 'zzz_studio_read_only'/); assert.match(MIG, /tgname = 'zz_quote_org_match'/);
  // defaults: admins, 3 / on the day / every 3, e-mail on, vendor OFF, Rs 10,000, 150 days, no TDS, late = admins
  for (const d of ["payer_role         text not null default 'admin'", 'days_before        integer not null default 3', 'overdue_every      integer not null default 3',
    'vendor_reminders   boolean not null default false', 'cash_limit         numeric not null default 10000', 'gst_warn_days      integer not null default 150',
    "late_who           text not null default 'admin'"]) assert.ok(MIG.includes(d), d);
});

await t('0373: TDS = its own payout row (source tds + section), idempotent, never overpays, cash over the limit only warns', () => {
  const pay = MIG.slice(MIG.indexOf('create or replace function public.vendor_bill_pay('), MIG.indexOf('-- ---- 5)'));
  assert.match(pay, /has_area\('finance', 'edit'\)/);
  assert.match(pay, /values \(b\.id, v_org, v_tds, v_day, 'TDS ' \|\| v_sec, v_ref, case when v_key is not null then v_key \|\| ':tds' end, 'tds', v_sec, v_row\.id\)/);
  assert.match(pay, /if v_amt \+ v_tds > v_open \+ 0\.005 then/);
  assert.match(pay, /for update/);
  assert.match(pay, /'code', 'cash_limit'/); assert.doesNotMatch(pay.split("'code', 'cash_limit'")[1].slice(0, 400), /raise exception/, 'a warning, never a block');
  assert.doesNotMatch(pay, /event_closed/, 'paying an already-recorded bill after close is allowed here');
});

await t('0373: late bills - reason row first in the same transaction, 0152 guard skips only that bill, admins by default, 0372 snapshot + switch when installed', () => {
  const g = MIG.slice(MIG.indexOf('create or replace function public.tg_a152_money_create_guard()'), MIG.indexOf('-- may this person add a late bill?'));
  assert.match(g, /l\.bill_id = new\.id and l\.quote_id = new\.quote_id and l\.tx = txid_current\(\)/);
  for (const keep of ["This event is closed - re-open it before adding a %.", "hint = 'not_confirmed'", "hint = 'refund_over_paid'", "pg_advisory_xact_lock(hashtextextended('helm:pay:quote:'"])
    assert.ok(g.includes(keep), 'kept: ' + keep);
  const late = MIG.slice(MIG.indexOf('create or replace function public.vendor_bill_add_late('), MIG.indexOf('-- ---- 8)'));
  assert.ok(late.indexOf('insert into public.vendor_bill_late') < late.indexOf('insert into public.vendor_bills'), 'reason row before the bill');
  assert.match(late, /_a156_vendor_bill_refs_ok\(p_quote, v_booking, v_vendor, v_file\)/);
  assert.match(late, /to_regprocedure\('public\._r372_snapshot\(uuid,uuid,text,text\)'\) is not null/);
  assert.match(late, /_r372_snapshot\(\$1, \$2, \$3, \$4\)\)' into v_snap using p_quote, v_org, 'late_adjustment'/);
  assert.match(MIG, /coalesce\(v ->> 'late_adjust', 'reopen'\) = 'admin'/, 'the 0372 money switch decides whether late costs are allowed');
  assert.match(MIG, /or public\._r373_cfg\(p_org\) ->> 'late_who' = 'finance'/);
});

await t('0373: typed advance -> payout rows (added only), ledger subtracts the converted part, advance then locked', () => {
  const cv = MIG.slice(MIG.indexOf('create or replace function public.vendor_bill_convert_advances('), MIG.indexOf('-- once part of a typed advance'));
  assert.match(cv, /insert into public\.vendor_payouts\(bill_id, org_id, amount, paid_on, method, reference, idempotency_key, source\)/);
  assert.match(cv, /v_use := round\(least\(v_open, v_left\), 2\)/);
  assert.doesNotMatch(cv, /update public\.event_resources/i, 'the typed advance is never edited');
  assert.match(MIG, /create trigger ad_r373_advance_lock before update of advance on public\.event_resources/);
  assert.match(MIG, /- public\._r373_converted\(nullif\(e\.i ->> 'source_id', ''\)::uuid\)/);
});

await t('0373: reminders - studio day + 9:00, before / due / every N days overdue (180 max), bell only for the payers, trial = bell only', () => {
  const tick = MIG.slice(MIG.indexOf('create or replace function public.vendor_bill_reminder_tick('), MIG.indexOf('-- comms-dispatch takes due e-mails'));
  assert.match(tick, /public\._r373_hour\(r\.org_id, v_now\) < 9/);
  assert.match(tick, /trial_send_blocked\(r\.org_id, r\.quote_id, null\)/);
  assert.match(tick, /'notify', v_notify/);
  assert.match(tick, /coalesce\(\(c ->> 'vendor_reminders'\)::boolean, false\)/);
  assert.match(MIG, /if d < 0 and -d <= 180 and \(\(-d - 1\) % n\) = 0 then return 'overdue:'/);
  assert.match(MIG, /coalesce\(v\.kind, ''\) <> 'vendor_bill_due'/);
  assert.match(MIG, /lower\(coalesce\(p\.role, ''\)\) not in \('', 'client', 'crew', 'worker'\)/, 'crew / clients are never payers');
  const claim = MIG.slice(MIG.indexOf('create or replace function public.vendor_bill_reminder_claim('), MIG.indexOf('create or replace function public.vendor_bill_reminder_mark('));
  assert.match(claim, /x ->> 'profile_id' = s\.profile_id::text and lower\(x ->> 'email'\) = lower\(s\.recipient\)/, 'still a payer at send time');
  assert.match(claim, /email_is_opted_out\(s\.org_id, s\.recipient\)/);
  assert.match(claim, /for update of x skip locked/);
});

await t('0373: grants - page functions for signed-in staff, timer / claim / mark for the service role only', () => {
  assert.match(MIG, /grant execute on function public\.vendor_bill_reminder_claim\(integer\) to service_role/);
  for (const f of ['vendor_bill_pay(uuid,numeric,numeric,text,date,text,text,text)', 'vendor_bill_convert_advances(uuid)', 'vendor_bill_attach(uuid,uuid)',
    'vendor_bill_add_late(uuid,jsonb,text)', 'vendor_bills_extra(uuid)', 'vendor_bills_due(integer)', 'vendor_tds_report(date,date)',
    'vendor_bill_settings_get()', 'vendor_bill_settings_set(jsonb)']) assert.ok(MIG.includes("'public." + f + "'"), f);
  for (const f of ['vendor_bill_reminder_tick(timestamptz)', 'vendor_bill_reminder_claim(integer)', '_r373_people(uuid)', '_r21_cost_lines__pre0373(uuid,uuid)'])
    assert.ok(MIG.split("foreach f in array array['public.vendor_bill_pay")[0].includes("'public." + f + "'"), f + ' in the server-only list');
});

await t('packaging: APPLY-0373 = begin + the migration + commit + an all-true verify; MANIFEST, run-all, trial purge test, prod checker override (one line)', () => {
  assert.ok(APPLY.includes(MIG.trim()), 'APPLY contains the migration verbatim');
  assert.match(APPLY, /^begin;$/m); assert.match(APPLY, /^commit;$/m);
  assert.ok(APPLY.indexOf('begin;') < APPLY.indexOf(MIG.trim().slice(0, 60)) && APPLY.indexOf('\ncommit;') > APPLY.indexOf('notify pgrst'));
  assert.match(APPLY, /select item, ok from \(values/);
  assert.doesNotMatch(code(APPLY), /create temp(orary)? table|^set\s+(local\s+|session\s+)?[a-z_.]+\s*(=|to)\s/im, 'paste-safe: no temp tables / session settings');
  assert.doesNotMatch(code(APPLY), /set_config\(/i, 'no session state');
  assert.match(MF, /^forward  supabase\/migrations\/0373_r190_vendor_bills_finish\.sql$/m);
  assert.match(RUNALL, /run "r190-vendor-bills-0373" "R190-VENDOR-BILLS-0373: ALL PASS \\\(48\/48\\\)" psql -q -f tests\/db\/r190-vendor-bills-0373\.sql/);
  assert.match(RET, /\\ir \.\.\/\.\.\/supabase\/migrations\/0373_r190_vendor_bills_finish\.sql/);
  assert.match(DBT, /R190-VENDOR-BILLS-0373: ALL PASS/); assert.match(DBT, /^rollback;$/m);
  const line = OVR.split('\n').find((l) => l.startsWith('  "0373": '));
  assert.ok(line && JSON.parse('{' + line.replace(/,$/, '') + '}')['0373'].ignore.includes('cron helm-vendor-bill-reminders'), 'one-line override');
  JSON.parse(OVR);
  assert.ok(PKG.includes('node test/r190-vendor-bills.test.mjs'));
});

await t('e-mail (office): before / due / overdue, plain words, link to the event Settlement page, fails closed', () => {
  const base = { audience: 'office', kind: 'before', name: 'Asha Admin', studio: 'Studio A', vendor: 'Sri Sai Tents', bill_no: 'T-142', amount: 18000, open: 18000,
    currency: 'INR', due_text: '20/12/2026', days: 3, event: 'Rao Wedding', event_date: '14/12/2026', quote_id: Q };
  const m = M.vendorBillMessage(base, ORIGIN);
  assert.equal(m.subject, 'Due soon: vendor bill Rs 18,000 to Sri Sai Tents - Rao Wedding');
  assert.match(m.text, /^Hello Asha,/);
  assert.match(m.text, /A vendor bill is due in 3 days: Rs 18,000 to Sri Sai Tents \(bill #T-142, due 20\/12\/2026\) for Rao Wedding \(14\/12\/2026\)\./);
  assert.ok(m.text.includes(ORIGIN + '/settlement.html?quote=' + Q + '#vendorBills'));
  assert.match(M.vendorBillMessage({ ...base, kind: 'due', days: 0 }, ORIGIN).subject, /^Due today: /);
  const o = M.vendorBillMessage({ ...base, kind: 'overdue', days: -4, open: 12500.5 }, ORIGIN);
  assert.match(o.subject, /^Overdue: vendor bill Rs 12,500\.50 to Sri Sai Tents/); assert.match(o.text, /overdue by 4 days/); assert.match(o.text, /Bill total Rs 18,000; Rs 12,500\.50 is still to be paid\./);
  assert.equal(M.billMoney(1234567, 'INR'), 'Rs 12,34,567'); assert.equal(M.billMoney(1250, 'AED'), 'AED 1,250');
  for (const bad of [{ ...base, kind: 'nope' }, { ...base, quote_id: 'x' }, { ...base, due_text: 'soon' }, { ...base, open: -1 }, { ...base, audience: 'crew' }, null])
    assert.equal(M.vendorBillMessage(bad, ORIGIN).text, '', JSON.stringify(bad));
  assert.equal(M.vendorBillMessage(base, 'http://insecure.test').text, '', 'never an http link');
  const x = M.vendorBillMessage({ ...base, vendor: '<b>X</b>', event: 'E<script>' }, ORIGIN);
  assert.doesNotMatch(x.text + x.subject, /[<>]/);
});

await t('e-mail (vendor): only vendor_before, no link, their own bill only; designed HTML on the shared layout, escaped', () => {
  const v = { audience: 'vendor', kind: 'vendor_before', studio: 'Studio A', vendor: 'Sri Sai Tents', bill_no: 'T-142', amount: 18000, open: 18000, currency: 'INR',
    due_text: '20/12/2026', days: 3, event: 'Rao Wedding', event_date: '14/12/2026', quote_id: Q };
  const m = M.vendorBillMessage(v, ORIGIN);
  assert.equal(m.subject, 'Your bill #T-142 from Studio A is due for payment on 20/12/2026');
  assert.doesNotMatch(m.text, /https?:\/\//, 'no link to the studio app');
  assert.equal(M.vendorBillMessage({ ...v, kind: 'overdue' }, ORIGIN).text, '', 'vendors only ever get the "due for payment" note');
  const h = M.vendorBillHtml({ ...v, vendor: 'A&B <Tents>' }, ORIGIN, {});
  assert.match(h, /^<!DOCTYPE html>/); assert.ok(h.includes('A&amp;B Tents')); assert.ok(!h.includes('<Tents>'));
  assert.ok(h.includes(M.VENDOR_BILL_VENDOR_TX_REASON));
  const ho = M.vendorBillHtml({ ...v, audience: 'office', kind: 'overdue', days: -1, name: 'Asha' }, ORIGIN, {});
  assert.ok(ho.includes('Record the payment')); assert.ok(ho.includes('/settlement.html?quote=' + Q + '#vendorBills')); assert.ok(ho.includes(M.VENDOR_BILL_TX_REASON));
  assert.equal(M.vendorBillHtml({ ...v, kind: 'bad' }, ORIGIN, {}), '');
});

await t('comms-dispatch: the vendor bill lane - claimed only with an e-mail provider, studio reply-to, footer by audience, designed HTML, every row marked', () => {
  assert.match(IDX, /import \{ vendorBillMessage, vendorBillHtml, VENDOR_BILL_TX_REASON, VENDOR_BILL_VENDOR_TX_REASON \} from "\.\/vendor-bill-reminder\.mjs";/);
  assert.match(IDX, /mailOn && !overBudget\(\) \? await admin\.rpc\("vendor_bill_reminder_claim", \{ p_limit: batch \}\) : NOCLAIM;/);
  assert.match(IDX, /await withReply\("vendorBill", id,/);
  assert.match(IDX, /=== "vendor" \? VENDOR_BILL_VENDOR_TX_REASON : VENDOR_BILL_TX_REASON/);
  assert.match(IDX, /admin\.rpc\("vendor_bill_reminder_mark", \{ p_id: id, p_status: res === "failed" \? "retry" : res \}\)/);
  assert.equal(RT.LANE_TABLES.vendorBill, 'vendor_bill_mail_outbox');
});

// the browser vendor rule: a converted typed advance is counted once
const src = API;
const s0 = src.indexOf('  const vbNum = (v) =>'), s1 = src.indexOf('  const vbTableMissing');
const ctx = { BPStore: { todayLocal: () => '2026-11-17' } }; vm.createContext(ctx);
vm.runInContext(src.slice(s0, s1) + '\nthis.settle = vendorSettle; this.state = vendorBillState;', ctx);

await t('store-api: vendorSettle counts a converted typed advance once (payout rows source advance), TDS rows settle the bill', () => {
  const bk = [{ id: 'b1', cost: 7000, advance: 5000, status: 'confirmed' }];
  const before = ctx.settle(bk, [{ id: 'x1', booking_id: 'b1', amount: 3000, bill_date: '2026-11-10', vendor_payouts: [] },
                                  { id: 'x2', booking_id: 'b1', amount: 4000, bill_date: '2026-11-12', vendor_payouts: [] }], '2026-11-17');
  const after = ctx.settle(bk, [{ id: 'x1', booking_id: 'b1', amount: 3000, bill_date: '2026-11-10', vendor_payouts: [{ amount: 3000, source: 'advance' }] },
                                 { id: 'x2', booking_id: 'b1', amount: 4000, bill_date: '2026-11-12', vendor_payouts: [{ amount: 2000, source: 'advance' }] }], '2026-11-17');
  assert.equal(before.byBooking.b1.paid, 5000); assert.equal(after.byBooking.b1.paid, 5000, 'not 10,000');
  assert.equal(before.byBooking.b1.owed, 2000); assert.equal(after.byBooking.b1.owed, 2000);
  assert.equal(after.byBill.x1.state, 'paid'); assert.equal(after.byBill.x2.left, 2000);
  assert.equal(ctx.state({ amount: 18000, vendor_payouts: [{ amount: 17640, source: 'manual' }, { amount: 360, source: 'tds' }] }, '2026-11-17'), 'paid');
});

await t('store-api: the 0373 calls, the bell label + deep link for vendor_bill_due', () => {
  for (const r of ['vendor_bill_pay', 'vendor_bills_extra', 'vendor_bill_convert_advances', 'vendor_bill_attach', 'vendor_bill_add_late', 'vendor_bills_due', 'vendor_tds_report',
    'vendor_bill_settings_get', 'vendor_bill_settings_set']) assert.ok(API.includes('rpc("' + r + '"'), r);
  assert.match(API, /if \(k === "vendor_bill_due"\) return "settlement\.html\?quote=" \+ enc\(q\) \+ "#vendorBills";/);
  assert.match(API, /vendor_bill_due: \["🧾", String\(d\.label \|\|/);
});

// the Business card helpers (pure)
const uw = {};
vm.runInNewContext(UI, { window: uw, document: { readyState: 'complete', querySelectorAll: () => [], addEventListener() {}, getElementById: () => null }, MutationObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
  URLSearchParams, location: { search: '' }, console, Promise, Math, Number, String, Object, Array, JSON, Date, isFinite });
await t('UI: WhatsApp summary of bills to pay + CSV formula guard (pure)', () => {
  const fmt = (n) => 'Rs ' + Number(n).toLocaleString('en-IN');
  const txt = uw.HelmVendorBills.dueSummary([
    { vendor: 'Sri Sai Tents', open: 18000, bill_no: 'T1', event: 'Rao Wedding', state: 'overdue', days: -4, due_date: '2026-11-13' },
    { vendor: 'Lotus', open: 2500, event: 'Iyer Sangeet', state: 'soon', days: 3, due_date: '2026-11-20' },
    { vendor: 'Old', open: 900, state: 'gst' }], fmt, '2026-11-17');
  assert.equal(txt, 'Vendor bills to pay (2026-11-17)\n\nOverdue:\n- Sri Sai Tents: Rs 18,000 (#T1) - Rao Wedding, 4 days late\n\nComing up:\n- Lotus: Rs 2,500 - Iyer Sangeet, due 2026-11-20\n\nTotal: Rs 20,500');
  assert.equal(uw.HelmVendorBills.dueSummary([], fmt, '2026-11-17'), 'No vendor bills due in the next 2 weeks.');
  assert.equal(uw.HelmVendorBills.csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"'); assert.equal(uw.HelmVendorBills.csvCell(-500), '"-500"');
});

await t('UI: Vendor bills card uses the 0373 calls only when the server has them; no HTML strings; Business mount; Settlement "Pay the bill"', () => {
  assert.doesNotMatch(UI, /innerHTML|insertAdjacentHTML|outerHTML/);
  assert.match(UI, /var withTds = !!\(ex && B\.vendorBills\.payTds\);/);
  assert.match(UI, /B\.vendorBills\.payTds\(b\.id, a, tv, tv > 0 \? sec : null/);
  assert.match(UI, /B\.vendorBills\.addLate\(id, bill, file, why\.value\)/);
  assert.match(UI, /B\.vendorBills\.attach\(id, b\.id, file\)/);
  assert.match(UI, /B\.vendorBills\.convertAdvances\(id\)/);
  assert.match(UI, /Section 40A\(3\)/); assert.match(UI, /GST credit: pay before/);
  assert.match(UI, /var MOUNTS = \{ bills: mountBills, pnl: mountPnl, business: mountBusiness, due: mountDue \};/);
  assert.match(UI, /finOk = await B\.auth\.canView\("finance"\)/, 'Business section needs Finance view');
  assert.match(BIZ, /<div id="vbDue" data-vb-mount="due" data-vb-gate="bzApp" hidden><\/div>/);
  assert.match(SET, /\(b\._billed&&!b\.settled\)\?`<button type="button" class="btn go" data-gobills="1"/);
  for (const c of ['.vb-warn', '.vb-set', '.bz-pill-bad']) assert.ok(CSS.includes(c), c);
});

await t('page tours: Settlement Vendor bills + the Business vendor bills section (Finance only)', () => {
  for (const sel of ['#vendorBills', '#bz-vb-due']) assert.match(TOURS, new RegExp('sel: "' + sel + '", need: "finance"'), sel);
});

console.log(`\nR190 vendor bills: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
