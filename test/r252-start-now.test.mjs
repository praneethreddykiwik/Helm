// r252-start-now.test.mjs - R252 (0434) "You can start now": the SQL's shape, and that what it queues is something the deployed
// comms-dispatch can already send (no edge function change): the WhatsApp fields of staff_task_changed, the e-mail of a
// staff_update_outbox line, the link paths. Behaviour of the SQL: tests/db/r252-start-now-0434.sql.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FIELDS, CATALOGUE_NAMES, fieldContent } from '../supabase/functions/_shared/wa-studio.mjs';
import { staffUpdateMessage, staffUpdateHtml } from '../supabase/functions/comms-dispatch/staff-email.mjs';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const M = '0434_r252_start_now', MIG = read('supabase/migrations/' + M + '.sql'), APPLY = read('supabase/APPLY-0434.sql');
const CODE = MIG.replace(/--.*$/gm, '');

t('ASCII, no psql meta / temp tables / session state, additive, marker, APPLY = migration + set local + check rows', () => {
  for (const s of [MIG, APPLY]) assert.ok(!/[^\x00-\x7F]/.test(s), 'ASCII');
  assert.ok(!/^\\/m.test(APPLY) && !/create\s+temp/i.test(APPLY) && !/\bset_config\(/.test(CODE) && !/^set (?!local)/m.test(APPLY));
  assert.ok(!/\bdrop\s+(table|column|index|policy|trigger|function)\b|\bdelete\s+from\b|\btruncate\b/i.test(CODE), 'additive');
  assert.match(APPLY, /\nbegin;\nset local lock_timeout = '5s';\nset local statement_timeout = '5min';\n/);
  assert.ok(APPLY.includes(MIG), 'APPLY carries the whole migration');
  assert.match(APPLY, /\) v\(item, ok\) order by item;\ncommit;\n$/);
  assert.ok(MIG.includes("values (434, '" + M + "') on conflict (num) do nothing"));
  assert.ok(read('supabase/migrations/MANIFEST').includes('forward  supabase/migrations/' + M + '.sql'));
  assert.ok(read('supabase/CHECK-PROD-MIGRATIONS.sql').includes(M));
  for (const s of ['r252-start-now-0434', 'r252-apply-0434']) assert.ok(read('scripts/db-test/run-all.sh').includes('run "' + s + '"'), s + ' wired');
});
t('every new function: security definer + empty search_path, and in the revoke list', () => {
  const fns = [...MIG.matchAll(/create or replace function public\.(\w+)\([^]*?\nreturns [^\n]*\n/g)];
  assert.ok(fns.length >= 19, String(fns.length));
  for (const f of fns) assert.ok(/security definer set search_path = ''/.test(f[0]), f[1]);
  for (const f of fns) if (f[1].startsWith('_r434_')) assert.ok(MIG.includes("'public." + f[1] + '('), f[1] + ' revoked');
});
t('the only rows it updates are its own (ledger, the WhatsApp row it just queued, stale start notices, the studio switch)', () => {
  const ups = [...CODE.matchAll(/\bupdate public\.(\w+)/g)].map((m) => m[1]).sort();
  assert.deepEqual(ups, ['assign_notify_outbox', 'assign_notify_outbox', 'task_reminder_settings', 'task_start_notices', 'task_start_notices']);
  assert.ok(!/update public\.event_tasks/.test(CODE));
});
t('the status change never fails: AFTER trigger, whole body guarded, returns null', () => {
  const b = MIG.slice(MIG.indexOf('function public._r434_tg_start_now()'));
  assert.match(b, /exception when others then\s+raise warning 'r252-0434: waiting tasks not told/);
  assert.match(MIG, /create trigger zzz_r434_start_now after update of status on public\.event_tasks/);
});
t('WhatsApp: staff_task_changed is a template Helm already creates and the 4 queued fields fit it', () => {
  assert.ok(CATALOGUE_NAMES.includes('staff_task_changed'));
  const c = fieldContent('staff_task_changed', ['Ravi', 'Drape', 'Rao Wedding', 'you can start now - Stage build is done'], '');
  assert.equal(FIELDS.staff_task_changed.length, 4);
  assert.equal(c.template.components[0].parameters[3].text, 'you can start now - Stage build is done');
});
t('e-mail: one staff_update line gives the exact words, text and HTML', () => {
  const row = { kind: 'task_update', name: 'Ravi Kumar', studio: 'Aurora', event: 'Rao Wedding', event_date: '25 Nov 2026', changes: ['You can start now: Drape - Stage build is done'],
    tasks: [{ title: 'Drape', start: null, day: null }], link_path: 'work.html?staff=' + 'a'.repeat(64), quote_id: 'a0000000-0000-4000-8000-00000000da01' };
  const m = staffUpdateMessage(row, 'https://www.helm.events');
  assert.ok(m.text.includes('  - You can start now: Drape - Stage build is done'));
  assert.equal(m.subject, 'Update: your tasks for Rao Wedding on 25 Nov 2026 changed');
  assert.ok(staffUpdateHtml(row, 'https://www.helm.events').includes('You can start now: Drape - Stage build is done'));
});

let bad = 0;
for (const [name, fn] of tests) { try { await fn(); console.log('  ok  ' + name); } catch (e) { bad++; console.error('  FAIL ' + name + '\n       ' + (e && e.message)); } }
console.log(bad ? 'r252-start-now: ' + bad + ' FAILED' : 'r252-start-now: ' + tests.length + ' passed');
process.exit(bad ? 1 : 0);
