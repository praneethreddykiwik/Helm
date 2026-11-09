// r130: WhatsApp templates per message + task reminders. Static + pure checks; behaviour: tests/db/r130-task-reminders-0338.sql.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const r = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const require = createRequire(import.meta.url);
let n = 0;
const t = async (name, fn) => { try { await fn(); n++; console.log('  ok ' + name); } catch (e) { console.error('  FAIL ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; } };
const SQL = r('supabase/migrations/0338_r130_task_reminders.sql'), APPLY = r('supabase/APPLY-0338.sql');
const code = SQL.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
const W = await import('../supabase/functions/_shared/wa-studio.mjs');
const TR = require('../public/task-reminders-ui.js');
const NOTE = require('../public/wa-setup-note.js');

await t('0338 in the manifest after 0337; APPLY carries it verbatim in one transaction; ASCII', () => {
  const mf = r('supabase/migrations/MANIFEST');
  assert.ok(mf.indexOf('0337_r129_studio_whatsapp.sql') < mf.indexOf('0338_r130_task_reminders.sql'));
  assert.ok(APPLY.includes(SQL.trim())); assert.match(APPLY, /^begin;$/m); assert.ok(APPLY.indexOf('commit;') < APPLY.indexOf('-- VERIFY'));
  for (const s of [SQL, APPLY]) assert.ok(/^[\x00-\x7F]*$/.test(s));
});
await t('additive: nothing dropped or deleted (only its own triggers are re-created)', () => {
  assert.doesNotMatch(code, /\bdrop\s+(table|column|policy|schema|view|function)\b/i);
  assert.doesNotMatch(code, /\bdelete\s+from\b/i); assert.doesNotMatch(code, /\btruncate\b/i);
  const drops = code.match(/drop trigger if exists [a-z0-9_]+/gi) || [];   // their own triggers only
  assert.deepEqual(drops.map((x) => x.split(' ').pop()).sort(), ['zz_quote_org_match', 'zz_r338_assign_fields', 'zz_r338_wa_tick']);
});
await t('owner defaults: 10 + 5 before, every 15 min, 3 times, office on, hold on', () => {
  assert.match(code, /default_before\s+integer\[\] not null default '\{10,5\}'/);
  assert.match(code, /late_every_min\s+integer not null default 15/); assert.match(code, /late_max\s+integer not null default 3/);
  assert.match(code, /alert_office\s+boolean not null default true/); assert.match(code, /hold_waiting\s+boolean not null default true/);
});
await t('the job: every minute, server only, free trial skipped, studio switch respected', () => {
  assert.match(code, /cron\.schedule\('helm-task-reminders', '\* \* \* \* \*', 'select public\.task_reminder_tick\(\)'\)/);
  assert.match(code, /trial_send_blocked\(r\.org_id/);
  assert.match(code, /if not coalesce\(\(c ->> 'enabled'\)::boolean, true\) then continue; end if;/);
  assert.doesNotMatch(code, /grant execute on function public\.task_reminder_tick[^;]* to (anon|authenticated)/);
});
await t('field templates: one per U-31 message + run-sheet; fields match the catalogue; body never starts/ends with a field', () => {
  const want = ['staff_task_assigned', 'staff_task_reminder', 'staff_task_overdue', 'staff_task_changed', 'staff_open_shift', 'staff_shift_result',
    'staff_leave_result', 'office_staff_alert', 'vendor_request', 'vendor_follow_up', 'vendor_delivery_reminder', 'vendor_invoice_update', 'crew_runsheet_reminder'];
  assert.deepEqual(Object.keys(W.FIELDS), want);
  const cat = Object.fromEntries(W.templateCatalogue('https://www.helm.events').map((x) => [x.name, x]));
  for (const name of want) {
    const body = cat[name].components[0];
    assert.equal((body.text.match(/\{\{\d+\}\}/g) || []).length, W.FIELDS[name].length, name);
    assert.equal(body.example.body_text[0].length, W.FIELDS[name].length, name);
    assert.doesNotMatch(body.text, /^\{\{|\}\}$/, name);
    assert.equal(cat[name].category, 'UTILITY');
  }
});
await t('the database fills the same field counts the templates expect', () => {
  assert.match(code, /'staff_task_reminder',\s*jsonb_build_array\(v_name, v_task, public\._r338_f\(v_ev ->> 'event', 100\), public\._r338_f\(v_when, 20\),/);
  const counts = { staff_task_assigned: 7, staff_open_shift: 8, crew_runsheet_reminder: 5, staff_task_overdue: 5, office_staff_alert: 7 };
  for (const [k, v] of Object.entries(counts)) assert.equal(W.FIELDS[k].length, v, k);
});
await t('fieldContent: "@link" becomes the full link; wrong field count refused; never an empty field', () => {
  const c = W.fieldContent('staff_task_overdue', ['Ravi', 'Stage', 'Rao Wedding', '12:30 PM', '@link'], 'https://www.helm.events/work.html?token=x');
  assert.equal(c.template.components[0].parameters[4].text, 'https://www.helm.events/work.html?token=x');
  assert.equal(W.fieldContent('staff_task_overdue', ['a'], ''), null);
  assert.equal(W.fieldContent('staff_task_overdue', ['', 'b', 'c', 'd', '@link'], '').template.components[0].parameters[0].text, '-');
  assert.match(W.fieldContent('staff_task_overdue', ['a', 'b', 'c', 'd', '@link'], '').template.components[0].parameters[4].text, /ask the office/);
});
await t('comms-dispatch: reminder lane (studio number only, not set up recorded) + field templates on assignments + wamid kept', () => {
  const s = r('supabase/functions/comms-dispatch/index.ts');
  assert.match(s, /admin\.rpc\("task_wa_claim"/); assert.match(s, /admin\.rpc\("task_wa_mark"/);
  assert.match(s, /if \(!sender\) \{ st = "not_set_up"; reason = "whatsapp_not_connected"; \}/);
  assert.match(s, /fieldContent\(meta\.template, meta\.params, link\)/);
  assert.match(s, /admin\.rpc\("assign_notify_wamid"/);
});
await t('settings explain the rule in plain words (owner: "properly mentioned")', () => {
  const x = TR.explain({ default_before: [10, 5], late_every_min: 15, late_max: 3, alert_office: true, hold_waiting: true });
  assert.match(x, /10 min and 5 min before/); assert.match(x, /every 15 minutes, up to 3 times/); assert.match(x, /event manager is told/);
  assert.match(x, /waits on an unfinished task/);
  assert.match(TR.explain({ default_before: [10], late_max: 0, alert_office: false, hold_waiting: false }), /Late reminders are off/);
});
await t('custom minutes: parsed, sorted, bad input refused', () => {
  assert.deepEqual(TR.parseCustom('45, 7').mins, [45, 7]);
  assert.equal(TR.parseCustom('x').ok, false); assert.equal(TR.parseCustom('2000').ok, false);
  assert.deepEqual(TR.sortMins([5, 10, 5, 0]), [10, 5, 0]);
});
await t('status chip words', () => {
  assert.equal(TR.chip({ what: 'reminder', status: 'delivered' }).text, 'Reminder: Delivered');
  assert.equal(TR.chip({ what: 'assigned', status: 'not_set_up' }).state, 'off');
  assert.match(TR.chip({ what: 'late', status: 'failed' }).title, /share the worker link/);
  assert.equal(TR.chip(null), null);
});
await t('"not set up" note: owner wording, Integrations button, silent when unknown', async () => {
  assert.match(NOTE.text('reminders'), /isn't set up for your studio yet/); assert.equal(NOTE.HREF, 'integrations.html#whatsapp');
  assert.equal(await NOTE.mount({ hidden: false, ownerDocument: null }, { store: { integrations: { waReady: async () => null } } }), null);
  assert.equal(await NOTE.mount({ hidden: false }, { store: { integrations: { waReady: async () => ({ connected: true }) } } }), true);
});
await t('Tasks & staff: no SMS wording, no Remind / Fire buttons, reminder tick boxes, WhatsApp line per task, note', () => {
  const h = r('public/ops.html');
  assert.doesNotMatch(h, /SMS/); assert.doesNotMatch(h, /id="remindDue"|id="fireDue"/);
  assert.match(h, /<fieldset class="trm-set" id="sc_rem"><\/fieldset>/);
  assert.match(h, /await BPStore\.ops\.setReminders\(scTaskId, remMins\)/);
  assert.match(h, /\$\{typeof waChip==="function"\?waChip\(t\):""\}/); assert.match(h, /<div id="waSetupNote" hidden><\/div>/);
  assert.ok(h.indexOf('task-reminders-ui.js') > 0 && h.indexOf('wa-setup-note.js') > 0);
});
await t('Settings card + open-shift note + quote box button', () => {
  assert.match(r('public/control.html'), /<div class="card" id="trmCard" hidden><\/div>/);
  assert.match(r('public/control.html'), /HelmTaskReminders\.settingsCard\(\$\("#trmCard"\)\)/);
  assert.match(r('public/crew-shifts.js'), /HelmWaSetupNote\.mount\(waNote/);
  assert.match(r('public/wa-proposal.js'), /"Set up WhatsApp \\u2192"/);
});
await t('Integrations card lists every template the server creates', () => {
  const C = require('../public/wa-connect-ui.js');
  assert.deepEqual(C.TEMPLATES.map((x) => x[0]), W.CATALOGUE_NAMES);
});
await t('store + bell + tour', () => {
  const s = r('public/store-api.js');
  assert.match(s, /setReminders: \(taskId, mins\) => rpc\("set_task_reminders"/); assert.match(s, /rpc\("task_wa_status"/);
  assert.match(s, /task_overdue: \["⏰"/); assert.match(s, /    taskReminders,   \/\/ R130 \(0338\)\n    activityText, init/);
  assert.match(r('public/page-tours.js'), /sel: "#trmLine"/);
  assert.match(r('docs/ops/TASK-REMINDERS.md'), /12:20, 12:25 and 12:27/);
});
console.log(`r130-task-reminders: ${n} passed`);
