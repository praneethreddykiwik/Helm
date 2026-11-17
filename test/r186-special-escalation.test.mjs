// R186 (0369): a special (P1) task NOT STARTED at its start time climbs an escalation ladder - worker + coordinator at the
// start, + manager at 5 min, + admin / owner at 10 min (studio setting) - bell for that step's people, e-mail through the
// staff e-mail lane, steps in the activity log, a badge on the Event day monitor Late panel.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); } };

const MIG = read('supabase/migrations/0369_r186_special_escalation.sql');
const APPLY = read('supabase/APPLY-0369.sql');
const MF = read('supabase/migrations/MANIFEST');
const RUNALL = read('scripts/db-test/run-all.sh');
const RET = read('tests/db/trial-retention-0184.sql');
const DBT = read('tests/db/r186-escalation-0369.sql');
const OVR = read('supabase/check-prod-overrides.json');
const API = read('public/store-api.js');
const MON = read('public/monitor.js'), MONC = read('public/monitor.css');
const TRM = read('public/task-reminders-ui.js'), TRMC = read('public/task-reminders.css');
const TOURS = read('public/page-tours.js');
const IDX = read('supabase/functions/comms-dispatch/index.ts');
const PKG = read('package.json');
const code = (s) => s.replace(/^\s*--.*$/gm, '');
const M = await import('../supabase/functions/comms-dispatch/staff-email.mjs');

const win = {};
vm.runInNewContext(MON, { window: win, document: { getElementById: () => null, readyState: 'complete', addEventListener() {} }, Intl, Date, Math, Number, String, Object, Array, JSON, isFinite, isNaN, Infinity, URL, URLSearchParams, setInterval() {}, localStorage: null });
const MONA = win.HelmMonitor;
const trmCtx = { window: {}, document: {} }; trmCtx.globalThis = trmCtx;
vm.runInNewContext(TRM.replace('(typeof window !== "undefined" ? window : globalThis)', '(window)'), trmCtx);
const TR = trmCtx.window.HelmTaskReminders;

await t('0369: zero data loss - additive only, guarded, ASCII, no apostrophes in comments', () => {
  assert.ok(/^[\x00-\x7f]*$/.test(MIG), 'ASCII only');
  assert.ok(!MIG.split('\n').some((l) => /^\s*--/.test(l) && l.includes("'")), 'no apostrophe in a comment line');
  assert.doesNotMatch(code(MIG), /\bdrop\s+(table|function|policy|index|trigger|column)\b|\bdelete\s+from\b|\btruncate\b/i);
  assert.doesNotMatch(code(MIG), /\bupdate\s+public\.(event_tasks|quotes|profiles|notifications|event_task_log|task_wa_outbox)\b/i, 'never updates existing user data');
  // the only UPDATEs touch the new ladder row and still-pending escalation e-mails
  for (const m of code(MIG).matchAll(/\bupdate\s+public\.([a-z_]+)/gi)) assert.ok(['task_escalation_steps', 'staff_email_outbox'].includes(m[1]), m[1]);
  assert.match(MIG, /where o\.kind = 'task_escalation' and o\.status = 'pending'/, 'claim only skips our own pending rows');
  // the two widened rules keep every old value (union of what is there + the new one)
  assert.ok(MIG.includes("regexp_matches(pg_get_constraintdef(c.oid), '''([a-z0-9_]+)''::text', 'g')"), 'reads the values allowed today');
  for (const v of ['office_alert', 'task_late', 'task_escalation', 'check_edit', 'reassigned', 'escalated']) assert.ok(MIG.includes("'" + v + "'"), v);
});

await t('0369: two new tables, RLS on, no grants, studio guards; one step row per task / start time / ladder / step', () => {
  assert.match(MIG, /create table if not exists public\.task_escalation_settings \(/);
  assert.match(MIG, /create table if not exists public\.task_escalation_steps \(/);
  assert.match(MIG, /execute format\('alter table public\.%I enable row level security', t\)/);
  assert.match(MIG, /execute format\('revoke all on table public\.%I from authenticated', t\)/);
  assert.match(MIG, /create unique index if not exists task_escalation_steps_once369 on public\.task_escalation_steps \(task_id, ref_start, ladder, step\)/);
  assert.match(MIG, /ladder in \('not_started', 'not_completed'\)/, 'room for the later not-completed ladder');
  assert.match(MIG, /default '\{0,5,10\}'/);
  assert.match(MIG, /tgname = 'zzz_studio_read_only'/); assert.match(MIG, /tgname = 'zz_quote_org_match'/);
});

await t('0369: SECURITY DEFINER with fixed search_path; server-only except the two Settings functions and the bell', () => {
  const fns = [...MIG.matchAll(/create or replace function (public\.[a-z0-9_]+)\(/g)].map((m) => m[1]);
  assert.ok(fns.length >= 9, fns.join(','));
  for (const m of MIG.matchAll(/create or replace function public\.[a-z0-9_]+\([^]*?\)\s*returns[^]*?as \$fn\$/g))
    assert.match(m[0], /security definer set search_path = ''/, m[0].slice(0, 80));
  assert.match(MIG, /grant execute on function public\.task_escalation_settings_get\(text\) to authenticated/);
  assert.match(MIG, /grant execute on function public\.task_escalation_settings_set\(text,boolean,integer\[\]\) to authenticated/);
  assert.match(MIG, /grant execute on function public\.bell_feed\(integer\) to authenticated/);
  assert.doesNotMatch(MIG, /to anon/);
  assert.match(MIG, /not public\.has_area\('controls', 'edit'\)/, 'saving needs Settings edit');
});

await t('0369: the ladder - who, when, once, stops when started; trial = bell only; worker not reminded twice', () => {
  assert.match(MIG, /t\.is_special/); assert.match(MIG, /t\.status in \('assigned', 'accepted'\)/);
  assert.match(MIG, /not coalesce\(q\.is_demo, false\)/);
  assert.match(MIG, /\(l\.ok and o\.id = v_lead\) or \(not l\.ok and o\.role in \('coordinator', 'supervisor'\)\)/, 'event lead else coordinator / supervisor roles');
  assert.match(MIG, /p_step >= 1 and o\.role = 'manager'/);
  assert.match(MIG, /p_step >= 2 and \(o\.role = 'admin' or o\.id = v_owner\)/);
  assert.match(MIG, /not public\._r283_is_off\(p\.id, p_org\)/, 'deactivated members never');
  assert.match(MIG, /not in \('', 'client', 'crew', 'worker'\)/, 'office people only');
  assert.match(MIG, /v_mail := not v_trial and public\._r361_on\(r\.org_id\) and public\._r361_live/, 'trial / switch off: no e-mail');
  assert.match(MIG, /'covered'/); assert.match(MIG, /'superseded'/); assert.match(MIG, /'missed'/);
  assert.match(MIG, /v_best_at < v_now - interval '10 minutes'/, 'never sent late');
  assert.match(MIG, /'esc\|' \|\| v_id::text \|\| '\|' \|\| \(p ->> 'profile_id'\)/, 'one e-mail per person per step');
  assert.match(MIG, /'notify', v_notify/);
  assert.match(MIG, /'escalated', left\(\(r\.t\)\.title, 300\)/, 'activity log row');
});

await t('0369: wraps kept once (task_reminder_tick, staff_email_claim, _r23_visible, bell_feed) and old markers still found', () => {
  for (const [fn, sig] of [['task_reminder_tick', 'timestamptz'], ['staff_email_claim', 'integer'], ['_r23_visible', 'uuid,uuid'], ['bell_feed', 'integer']]) {
    assert.ok(MIG.includes(`to_regprocedure('public.${fn}__pre0369(${sig})') is null then\n    alter function public.${fn}(`), fn + ' rename once');
  }
  assert.match(MIG, /the r179-0367 timer \(kept as task_reminder_tick__pre0369\)/);
  assert.match(MIG, /the r24-ci-0270 \+ r163-0357 body/);
  assert.match(MIG, /where coalesce\(v\.kind, ''\) <> 'task_escalated'\s+or exists \(select 1 from public\.notifications n/);
});

await t('0369: APPLY verbatim, MANIFEST, run-all, retention re-run, one-line override, release lists, package test list', () => {
  assert.equal(APPLY.slice(APPLY.indexOf('begin;\n') + 7, APPLY.indexOf('\ncommit;\n')).trim(), MIG.trim());
  assert.match(APPLY, /^-- APPLY-0369 \(R186 [^\n]*\)\. Run on STAGING first, then production\. Safe to run twice\.\n/);
  assert.match(APPLY, /select item, ok from \(values/);
  assert.doesNotMatch(code(APPLY), /create temp|pg_temp|set local|set session/i, 'paste-safe');
  assert.ok(MF.includes('forward  supabase/migrations/0369_r186_special_escalation.sql'));
  assert.match(RUNALL, /R186-ESCALATION-0369: ALL PASS \\\(41\/41\\\)/);
  assert.match(DBT, /R186-ESCALATION-0369: ALL PASS/);
  assert.match(RET, /\\ir \.\.\/\.\.\/supabase\/migrations\/0369_r186_special_escalation\.sql/);
  const line = OVR.split('\n').find((l) => l.startsWith('  "0369": '));
  assert.ok(line && JSON.parse('{' + line.replace(/,\s*$/, '') + '}')['0369'].add.length === 4, 'one line, four markers');
  JSON.parse(OVR);
  for (const f of ['test/release-1019.test.mjs', 'test/release-1020.test.mjs']) assert.ok(read(f).includes("'0368', '0369']"), f);
  assert.ok(PKG.includes('node test/r186-special-escalation.test.mjs'));
});

const O = 'https://www.helm.events', QID = 'd1f9dac9-2eec-41c7-a0e0-36ca7bce50f2';
const row = { kind: 'task_escalation', studio: 'Aurora & Co', event: 'Rao Wedding', event_date: '20 Dec 2026', venue: 'Grand Hall', name: 'Manu Manager',
  task: 'Receive the groom', worker: 'Guest Desk', start: '3:00 PM', day: '20 Dec 2026', quote_id: QID, link_path: 'monitor.html?quote=' + QID, step: 2, late_min: 5 };

await t('comms-dispatch: the escalation e-mail (text + designed HTML), monitor link, its own reason line', () => {
  assert.ok(M.STAFF_KINDS.includes('task_escalation'));
  const m = M.staffEmailMessage(row, O);
  assert.equal(m.subject, 'Escalated: Receive the groom not started (Guest Desk) - Rao Wedding');
  assert.match(m.text, /^Hello Manu,\n\nGuest Desk has not started Receive the groom for Rao Wedding on 20 Dec 2026 at Grand Hall\. It was due at 3:00 PM on 20 Dec 2026 \(5 min ago\)\./);
  assert.match(m.text, /Step 2 of 3: the coordinator and the manager are told\./);
  assert.ok(m.text.includes(O + '/monitor.html?quote=' + QID));
  const h = M.staffEmailHtml(row, O, { address: 'Test Street 1' });
  assert.ok(h.startsWith('<!DOCTYPE html>')); assert.ok(h.includes('Special task not started')); assert.ok(h.includes('Open the live monitor'));
  assert.ok(h.includes('Aurora &amp; Co')); assert.ok(h.includes(M.ESCALATION_TX_REASON.replace("'", '&#39;')) || h.includes(M.ESCALATION_TX_REASON));
  assert.equal(M.staffLink({ kind: 'task_escalation', link_path: 'monitor.html?quote=' + QID }, O), O + '/monitor.html?quote=' + QID);
  assert.equal(M.staffLink({ kind: 'task_escalation', link_path: 'monitor.html?quote=evil' }, O), '');
  assert.equal(M.staffEmailMessage({ ...row, task: '' }, O).text, '', 'no task -> not sent');
  assert.match(M.staffEmailMessage({ ...row, step: 9 }, O).text, /Step 3 of 3: the coordinator, the manager and the admin \/ owner are told/);
  assert.match(IDX, /sk === "task_escalation" \? ESCALATION_TX_REASON/);
});

await t('bell: label + opens the Event day monitor; Settings store calls', () => {
  assert.match(API, /task_escalated: \["🚨", String\(d\.label \|\|/);
  assert.match(API, /if \(k === "task_escalated"\) return "monitor\.html\?quote=" \+ enc\(q\);/);
  assert.ok(API.indexOf('if (k === "task_escalated")') < API.indexOf('if (k.indexOf("task_") === 0) return "ops.html'), 'before the generic task_ link');
  assert.match(API, /rpc\("task_escalation_settings_get", \{ p_ladder: "not_started" \}\)/);
  assert.match(API, /rpc\("task_escalation_settings_set", \{ p_ladder: "not_started", p_enabled: !!enabled,/);
});

await t('Settings: escalation steps checked like the server (rising, first 0-60, last <= 120) + plain words', () => {
  assert.equal(JSON.stringify(TR.checkEscSteps(['0', '5', '10'])), '{"ok":true,"steps":[0,5,10]}');
  assert.equal(TR.checkEscSteps(['5', '5', '10']).ok, false);
  assert.equal(TR.checkEscSteps(['61', '70', '80']).ok, false);
  assert.equal(TR.checkEscSteps(['0', '5', '121']).ok, false);
  assert.equal(TR.checkEscSteps(['0', 'x', '10']).ok, false);
  assert.equal(TR.checkEscSteps(['0', '5']).ok, false);
  assert.match(TR.escExplain({ enabled: true, steps: [0, 5, 10] }), /at the start time the person and the event coordinator are told; 5 min after the start the manager too; 10 min after the start the admin \/ owner too/);
  assert.match(TR.escExplain({ enabled: false }), /Escalation is off/);
  assert.match(TRM, /escalationPart\(host, R, can\);/);
  assert.match(TRM, /x\.disabled = !can;/);
  assert.match(TRMC, /\.trm-esc-grid\{/);
});

await t('monitor: Activity shows escalation steps; Late panel badge "Escalated to manager <time>" for the current start only', () => {
  const ps = '2026-12-20T09:30:00.000Z';
  const acts = [
    { kind: 'escalated', task_id: 'T1', at: '2026-12-20T09:30:10Z', detail: { level: 'coordinator', ref_start: ps, to: ['Cora'] } },
    { kind: 'escalated', task_id: 'T1', at: '2026-12-20T09:35:10Z', detail: { level: 'manager', ref_start: ps, to: ['Cora', 'Manu'] } },
    { kind: 'escalated', task_id: 'T1', at: '2026-12-20T09:50:10Z', detail: { level: 'admin', ref_start: '2026-12-20T08:00:00.000Z' } },
    { kind: 'escalated', task_id: 'T2', at: '2026-12-20T09:59:10Z', detail: { level: 'admin', ref_start: ps } },
  ];
  const e = MONA.lastEscalation({ id: 'T1', planned_start: ps }, acts);
  assert.equal(e.detail.level, 'manager');
  assert.match(MONA.escBadge(e), /^Escalated to manager \d{1,2}:\d{2}/);
  assert.equal(MONA.lastEscalation({ id: 'T3', planned_start: ps }, acts), null);
  assert.equal(MONA.actGroup('escalated'), 'escalation');
  assert.equal(MONA.actText({ kind: 'escalated', title: 'Receive the groom', detail: { level: 'admin', to: ['A', 'B'] } }),
    '“Receive the groom” not started - escalated to admin / owner (A, B)');
  assert.match(MON, /\["escalation", "Escalations"\]/);
  assert.match(MON, /k === "task_escalation" \? "Escalation e-mail"/);
  assert.match(MONC, /\.mon-chip\.mon-esc\{[^}]*white-space:normal/, 'badge wraps at 375px');
});

await t('page tours: Late panel + Settings escalation steps', () => {
  assert.match(TOURS, /\{ sel: "#monAlerts", title: "Late tasks", desc: "[^"]*Escalated to manager/);
  assert.match(TOURS, /\{ sel: "#trmCard", title: "Task reminders and escalation"/);
});

console.log(`\nR186 special escalation: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
