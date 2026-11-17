// R189 (0372) Money phase 1 "Lock the money": frozen P&L at close (versions), corrections as new rows, Confirm attendance
// (day rate x days + overtime + allowance), client TDS as settled + Form 16A, big-gap / Unplanned flags, cancelled events in
// the monthly profit, GST + TDS by month, money rules with safe defaults. Static + pure-helper checks (the behaviour is
// proven on a real database by tests/db/r189-money-lock-0372.sql).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); } };

const MIG = read('supabase/migrations/0372_r189_money_lock.sql');
const APPLY = read('supabase/APPLY-0372.sql');
const MF = read('supabase/migrations/MANIFEST');
const RUNALL = read('scripts/db-test/run-all.sh');
const RET = read('tests/db/trial-retention-0184.sql');
const DBT = read('tests/db/r189-money-lock-0372.sql');
const OVR = read('supabase/check-prod-overrides.json');
const API = read('public/store-api.js');
const UI = read('public/money-lock-ui.js'), CSS = read('public/money-lock.css');
const LEDGER = read('public/money-ledger-ui.js');
const TOURS = read('public/page-tours.js');
const PKG = read('package.json');
const PAGES = { closure: read('public/closure.html'), settlement: read('public/settlement.html'), business: read('public/business.html'), control: read('public/control.html') };
const code = (s) => s.replace(/^\s*--.*$/gm, '');
const fnBody = (name) => { const i = MIG.indexOf('create or replace function public.' + name + '('); assert.ok(i >= 0, name); return MIG.slice(i, MIG.indexOf('end $$;', i)); };

await t('0372: zero data loss - additive, ASCII, no apostrophes in comments, nothing dropped / deleted / truncated', () => {
  assert.ok(/^[\x00-\x7f]*$/.test(MIG), 'ASCII only');
  assert.ok(!MIG.split('\n').some((l) => /^\s*--/.test(l) && l.includes("'")), 'no apostrophe in a comment line');
  assert.doesNotMatch(code(MIG), /\bdrop\s+(table|function|policy|index|column|view)\b|\bdelete\s+from\b|\btruncate\b/i);
  // the only trigger dropped is its own (re-created on the next line, safe to run twice)
  for (const m of code(MIG).matchAll(/\bdrop\s+trigger\s+if\s+exists\s+([a-z0-9_]+)/gi)) assert.equal(m[1], 'zzz_r372_close_snapshot');
  // the only UPDATE is the payment schedule covering a payment (the 0264 rule, now also with client TDS)
  for (const m of code(MIG).matchAll(/\bupdate\s+public\.([a-z_]+)/gi)) assert.equal(m[1], 'payment_milestones', m[0]);
  assert.match(MIG, /insert into public\.money_settings as s .* on conflict \(org_id\) do update/s, 'settings are an upsert of the studio row');
});

await t('0372: six new tables - RLS on, closed to the app, insert-only (keep trigger), studio guards, purge / keep lists', () => {
  for (const tb of ['money_settings', 'event_pnl_snapshots', 'money_corrections', 'crew_wage_confirmations', 'client_tds', 'client_tds_certificates']) {
    assert.match(MIG, new RegExp('create table if not exists public\\.' + tb + ' \\('), tb);
    assert.ok(MIG.includes("'" + tb + "'"), tb + ' in the RLS / guard loops');
  }
  assert.match(MIG, /alter table public\.%I enable row level security/);
  assert.match(MIG, /revoke all on table public\.%I from authenticated/);
  assert.doesNotMatch(code(MIG), /grant\s+(select|insert|update|delete|all)\s+on\s+(table\s+)?public\./i, 'no table grants');
  const keep = fnBody('_r372_tg_keep');
  assert.match(keep, /tg_op = 'DELETE' and public\._r55_purge_allowed\(old\.org_id\)/, 'delete only with the purge mark');
  assert.match(keep, /raise exception 'Money records are kept for good/);
  assert.match(MIG, /create trigger aa_r372_keep before update or delete on public\.%I/);
  assert.match(MIG, /tg_studio_read_only\(''org_id''\)/);
  assert.match(MIG, /tg_quote_org_match\(\)/);
  assert.ok(MIG.includes("''client_tds_certificates'', ''client_tds'', ''event_pnl_snapshots'', ''money_corrections'', ''crew_wage_confirmations'''"));
  assert.match(MIG, /'''comms_settings'', ''money_settings'''/);
});

await t('0372: six functions wrapped ONCE with the old bodies kept as __pre0372; the wrappers carry the kept markers', () => {
  for (const [f, a] of [['_r21_cost_lines', 'uuid, uuid'], ['_r21_event_money', 'uuid, uuid, boolean'], ['_vb_event_pnl', 'uuid, uuid'],
                        ['_a49_close_blockers', 'uuid'], ['_pst_allocate', 'uuid'], ['business_pnl', 'date, date']]) {
    const sig = a.replace(/ /g, '');
    assert.ok(MIG.includes(`if to_regprocedure('public.${f}__pre0372(${sig})') is null then\n    alter function public.${f}(${a}) rename to ${f}__pre0372;`), f);
    assert.match(fnBody(f), new RegExp('public\\.' + f + '__pre0372\\('), f + ' calls the kept body');
  }
  assert.match(fnBody('_r21_cost_lines'), /r21-money-0246 \/ r22-money-0252 \/ r23-crew-0265/);
  assert.match(fnBody('_a49_close_blockers'), /0110 \/ manager-1019-0152 \/ helm-0198-stages/);
  assert.match(fnBody('business_pnl'), /r20-business-0239/);
});

await t('0372: frozen P&L - every close path through ONE trigger, never blocks the close, versions, frozen numbers with live cash', () => {
  assert.match(MIG, /create trigger zzz_r372_close_snapshot after insert or update of closed_at on public\.event_closure/);
  const tg = fnBody('_r372_tg_close_snapshot');
  assert.match(tg, /if tg_op = 'UPDATE' and old\.closed_at is not null then return null; end if;/, 'only the moment it closes');
  assert.match(tg, /exception when others then\s+raise warning/, 'a failure never blocks the close');
  assert.match(tg, /'pnl_snapshot_failed'/);
  const snap = fnBody('_r372_snapshot');
  assert.match(snap, /coalesce\(v_prev\.version, 0\) \+ 1/);
  assert.match(snap, /pg_advisory_xact_lock\(hashtextextended\('helm:pnl:'/);
  assert.match(MIG, /constraint event_pnl_snapshots_version_uq unique \(quote_id, version\)/);
  const vb = fnBody('_vb_event_pnl');
  assert.match(vb, /freeze_closed/);
  assert.match(vb, /s\.pnl \|\| jsonb_build_object\('bills_paid', v -> 'bills_paid', 'bills_due', v -> 'bills_due'/, 'cash columns stay live');
  assert.match(fnBody('_r372_current_snapshot'), /s\.closed_at = c\.closed_at/, 'only the snapshot of the CURRENT close counts');
  assert.match(fnBody('pnl_freeze_now'), /public\.is_admin\(\)/);
  assert.match(fnBody('pnl_freeze_now'), /'manual_freeze'/);
});

await t('0372: corrections + late adjustments - new rows only; closed = re-open first unless the studio lets an admin', () => {
  const c = fnBody('money_correction_add');
  assert.match(c, /has_area\('finance', 'edit'\)/);
  assert.match(c, /v_closed and not \(public\.is_admin\(\) and v_cfg ->> 'late_adjust' = 'admin'\)/);
  assert.match(c, /if v_closed then perform public\._r372_snapshot\(p_quote, v_org, 'late_adjustment', v_reason\)/);
  assert.match(c, /char_length\(v_reason\) < 5/);
  assert.match(fnBody('_r21_event_money'), /'cost_other', coalesce\(\(m ->> 'cost_other'\)::numeric, 0\) \+ v_corr/, 'old keys still add up');
});

await t('0372: wages - confirm attendance; overtime / half day / allowance count only when switched on (safe defaults)', () => {
  const w = fnBody('_r372_wage');
  assert.match(w, /when coalesce\(\(p_cfg ->> 'half_day'\)::boolean, false\) then coalesce\(p_days, 0\) else ceil\(coalesce\(p_days, 0\)\)/, 'half day off = full day');
  assert.match(w, /if coalesce\(\(p_cfg ->> 'ot_enabled'\)::boolean, false\) and coalesce\(p_ot, 0\) > 0 then/);
  assert.match(w, /if coalesce\(\(p_cfg ->> 'allowance_enabled'\)::boolean, false\) then v_allow/);
  assert.match(MIG, /ot_enabled\s+boolean not null default false/);
  assert.match(MIG, /half_day\s+boolean not null default false/);
  assert.match(MIG, /allowance_enabled boolean not null default false/);
  assert.match(MIG, /cancelled_in_pnl\s+boolean not null default false/);
  assert.match(MIG, /late_adjust\s+text not null default 'reopen'/);
  assert.match(MIG, /gap_pct\s+numeric not null default 10 /);
  assert.match(MIG, /gap_abs\s+numeric not null default 10000 /);
  const s = fnBody('_r372_suggest');
  assert.match(s, /from public\.crew_checkins k/, 'suggested from the crew link check-ins');
  assert.match(s, /d\.status in \('arrived', 'left'\)/);
  const att = fnBody('crew_attendance');
  assert.match(att, /case when v_admin then jsonb_build_object\('day_rate'/, 'rates + wages only for the admin');
  const cf = fnBody('crew_attendance_confirm');
  assert.match(cf, /continue when exists \(select 1 from public\.crew_wage_confirmations c where c\.quote_id = p_quote and c\.crew_id = v_crew\)/, 'one tap never re-confirms');
  assert.match(cf, /continue when v_sug ->> 'source' = 'none'/, 'not marked stays an estimate');
  assert.match(cf, /v_days \* 2 <> floor\(v_days \* 2\)/, 'half days only');
});

await t('0372: client TDS - settled in the close gate, covers the payment schedule, capped at the balance, minus-row reversal', () => {
  const b = fnBody('_a49_close_blockers');
  assert.match(b, /- coalesce\(\(b ->> 'paid'\)::numeric, 0\) - v_tds/);
  assert.match(b, /'balance_before_tds', b -> 'balance_owed'/);
  assert.match(fnBody('_pst_allocate'), /v_credit \+ v_tds -/);
  const r = fnBody('client_tds_record');
  assert.match(r, /if v_amt > v_left \+ 0\.5 then/);
  assert.match(r, /set_config\('helm\.r282_pay', p_quote::text, true\)/, 'after closing the schedule may still be covered (like record_payment)');
  assert.match(fnBody('client_tds_reverse'), /-t\.amount, t\.section, t\.rate, left\('Reversed: '/);
  assert.match(MIG, /check \(\(amount > 0 and corrects_id is null\) or \(amount < 0 and corrects_id is not null\)\)/);
  assert.match(MIG, /create unique index if not exists client_tds_one_reversal_uq/);
  assert.match(MIG, /constraint client_tds_certificates_one_uq unique \(tds_id\)/);
});

await t('0372: access - every page function needs Finance view / edit (Settings edit for rules, Business for monthly tax); no anon', () => {
  for (const f of ['event_pnl_versions', 'crew_attendance', 'client_tds_list']) assert.match(fnBody(f), /has_area\('finance', 'view'\)/, f);
  for (const f of ['money_correction_add', 'crew_attendance_confirm', 'client_tds_record', 'client_tds_reverse', 'client_tds_form16a']) assert.match(fnBody(f), /has_area\('finance', 'edit'\)/, f);
  assert.match(fnBody('money_settings_set'), /has_area\('controls', 'edit'\)/);
  assert.match(fnBody('business_tax_by_month'), /has_area\('business', 'view'\)/);
  for (const f of ['event_pnl_versions', 'crew_attendance', 'client_tds_list', 'money_correction_add', 'crew_attendance_confirm', 'client_tds_record'])
    assert.match(fnBody(f), /q\.org_id = v_org/, f + ' own studio');
  assert.match(MIG, /execute format\('revoke all on function %s from anon', f\)/);
  assert.match(MIG, /'public\._r372_snapshot\(uuid,uuid,text,text\)'/);
  for (const m of MIG.matchAll(/create or replace function public\.([a-z0-9_]+)\([^)]*\)\s*\nreturns[^\n]*security definer set search_path = ''/g)) assert.ok(m[1]);
  assert.doesNotMatch(code(MIG), /security definer(?! set search_path = '')/, 'every definer has a fixed search_path');
});

await t('APPLY-0372 = paste-safe wrapper of the migration; MANIFEST, run-all, trial retention, prod checker', () => {
  assert.ok(APPLY.startsWith('-- APPLY-0372'));
  assert.ok(APPLY.includes('\nbegin;\n' + MIG) && APPLY.trimEnd().endsWith('commit;'), 'begin + migration + commit');
  assert.doesNotMatch(code(MIG), /\bcreate\s+temp(orary)?\s+table\b|^\s*\\|^\s*set\s+(local\s+)?[a-z_.]+\s*(=|to)/im, 'no temp tables / psql meta / session settings');
  assert.match(MIG, /select item, ok from \(values\n/);
  assert.match(MF, /\nforward  supabase\/migrations\/0372_r189_money_lock\.sql\n/);
  assert.match(RUNALL, /run "r189-money-lock-0372" "R189-MONEY-LOCK-0372: ALL PASS \\\(48\/48\\\)"/);
  assert.match(RET, /\\ir \.\.\/\.\.\/supabase\/migrations\/0372_r189_money_lock\.sql/);
  assert.match(DBT, /\\ir \.\.\/\.\.\/supabase\/migrations\/0372_r189_money_lock\.sql\n\\ir \.\.\/\.\.\/supabase\/migrations\/0372_r189_money_lock\.sql/);
  assert.ok(JSON.parse(OVR));
  assert.ok(PKG.includes('node test/r189-money-lock.test.mjs'));
});

await t('store-api: moneyLock RPC wrappers + Settlement balance counts client TDS; pure helpers', () => {
  for (const f of ['money_settings_get', 'money_settings_set', 'event_pnl_versions', 'pnl_freeze_now', 'money_correction_add', 'crew_attendance',
                   'crew_attendance_confirm', 'client_tds_list', 'client_tds_record', 'client_tds_reverse', 'client_tds_form16a', 'business_tax_by_month'])
    assert.ok(API.includes('"' + f + '"'), f);
  assert.match(API, /\n    moneyLock,   \/\/ R189 \(0372\)\n/);
  assert.match(API, /if \(tds\) \{ out\.clientTds = tds; out\.balance = Math\.round\(\(balance - tds\) \* 100\) \/ 100; \}/);
  const src = API.slice(API.indexOf('  function mlkAttendanceRow('), API.indexOf('  const moneyLock = {'));
  const ctx = {}; vm.runInNewContext(src + '\nthis.row = mlkAttendanceRow; this.amt = mlkAmount;', ctx);
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.row('c1', '1.5', { ot_hours: '2', allowance: '' }))), { crew_id: 'c1', days: 1.5, ot_hours: 2 });
  assert.ok(ctx.row('c1', '0.3').error, '0.3 day refused');
  assert.ok(ctx.row('c1', '61').error);
  assert.ok(ctx.row('c1', '1', { ot_hours: '-1' }).error);
  assert.equal(ctx.row('c1', '0').days, 0, 'a no-show is 0');
  assert.equal(ctx.amt('-2,000'), -2000); assert.equal(ctx.amt('₹1500.50'), 1500.5); assert.ok(isNaN(ctx.amt('abc'))); assert.ok(isNaN(ctx.amt('1.234')));
});

await t('UI: money-lock-ui.js - DOM only (no HTML strings), every amount masked, mounted on Closure / Settlement / Business / Settings', () => {
  assert.doesNotMatch(UI, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.ok((UI.match(/money\(el\(|moneyTd\(/g) || []).length >= 15, 'amounts carry data-money');
  for (const k of ['frozen', 'attendance', 'tds', 'business', 'settings']) assert.ok(UI.includes(k + ': mount'), k);
  assert.match(PAGES.closure, /data-mlk-mount="frozen" id="frozenPnl" hidden/);
  assert.match(PAGES.closure, /data-mlk-mount="attendance" id="crewAttendance" hidden/);
  assert.match(PAGES.settlement, /data-mlk-mount="tds" id="clientTds" hidden/);
  assert.match(PAGES.settlement, /helm:tds-changed/);
  assert.match(PAGES.settlement, /s\.clientTds>0\?`<tr><td>TDS deducted by the client/);
  assert.match(PAGES.business, /data-mlk-mount="business" data-mlk-gate="bzApp" hidden/);
  assert.match(PAGES.control, /class="card" id="mlkCard" data-mlk-mount="settings" hidden/);
  for (const p of Object.values(PAGES)) { assert.match(p, /money-lock-ui\.js\?v=\d+/); assert.match(p, /money-lock\.css\?v=\d+/); }
  assert.match(CSS, /@media \(max-width:720px\)/, 'phone layout (cards, no horizontal scroll)');
  // only Finance roles: every card checks Finance view first (the server checks again)
  assert.equal((UI.match(/await B\.auth\.canView\("finance"\)/g) || []).length, 3);
  // the ledger card prefers the server flag and shows the Unplanned tag
  assert.match(LEDGER, /typeof row\.flag === "string" \? row\.flag : B\.moneyLedger\.varianceFlag\(row\)/);
  assert.match(LEDGER, /"ml-chip-unplanned", "Unplanned"/);
});

await t('page tours: the new cards are explained (Closure, Settlement, Business, Settings)', () => {
  for (const s of ['#frozenPnl', '#crewAttendance', '#clientTds', '#mlkBiz', '#mlkCard']) assert.ok(TOURS.includes('"' + s + '"'), s);
});

console.log(`\nr189-money-lock: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
