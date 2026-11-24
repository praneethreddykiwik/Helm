// r253-start-now-mail.test.mjs - R253 (0436): the SQL's shape, the "You can start now" / "Please hold" e-mail (and that both halves
// degrade: new SQL + old sender = the R172 words, new sender + old SQL = the R172 words), the WhatsApp fields, the waits-for line of the
// task pages and the bell. Behaviour of the SQL: tests/db/r253-start-now-mail-0436.sql, r253-order-0436.sh.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fieldContent } from '../supabase/functions/_shared/wa-studio.mjs';
import { staffUpdateMessage, staffUpdateHtml, startItems } from '../supabase/functions/comms-dispatch/staff-email.mjs';
const require = createRequire(import.meta.url);
const W = require('../public/task-waits.js');
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const M = '0436_r253_start_now_mail', MIG = read('supabase/migrations/' + M + '.sql'), APPLY = read('supabase/APPLY-0436.sql');
const CODE = MIG.replace(/--.*$/gm, '');
const ORIGIN = 'https://www.helm.events', LINE = 'You can start now: Flowers - Stage set-up is done';
const ITEM = { type: 'start_now', line: LINE, task: 'Flowers', section: 'Decor', start: '4:00 PM', day: '25 Nov 2026', earlier: 'Stage set-up', earlier_state: 'done', by: 'Anu Rao', at: '3:40 PM', at_day: '25 Nov 2026' };
const ROW = { kind: 'task_update', name: 'Ravi Kumar', studio: 'Aurora', event: 'Rao wedding', event_date: '25 Nov 2026', venue: 'Taj Krishna', changes: [LINE], more: 0, cancelled: false,
  tasks: [{ title: 'Flowers', start: '4:00 PM', day: '25 Nov 2026' }], link_path: 'work.html?staff=' + 'a'.repeat(64), quote_id: 'a0000000-0000-4000-8000-00000000da01', start_now: [ITEM] };

t('ASCII, no psql meta / temp tables / session state, additive, marker, APPLY = migration + set local + check rows, wired', () => {
  for (const s of [MIG, APPLY]) assert.ok(!/[^\x00-\x7F]/.test(s), 'ASCII');
  assert.ok(!/^\\/m.test(APPLY) && !/create\s+temp/i.test(APPLY) && !/\bset_config\(/.test(CODE) && !/^set (?!local)/m.test(APPLY));
  assert.ok(!/\bdrop\s+(table|column|index|policy|trigger|function)\b|\bdelete\s+from\b|\btruncate\b/i.test(CODE), 'additive');
  assert.match(APPLY, /\nbegin;\nset local lock_timeout = '5s';\nset local statement_timeout = '5min';\n/);
  assert.ok(APPLY.includes(MIG)); assert.match(APPLY, /\) v\(item, ok\) order by item;\ncommit;\n$/);
  assert.match(APPLY, /12 SUPERVISOR CHECK/);
  assert.ok(MIG.includes("values (436, '" + M + "') on conflict (num) do nothing"));
  assert.ok(read('supabase/migrations/MANIFEST').includes('forward  supabase/migrations/' + M + '.sql') && read('supabase/CHECK-PROD-MIGRATIONS.sql').includes(M));
  for (const s of ['r253-start-now-mail-0436', 'r253-apply-0436', 'r253-order-0436']) assert.ok(read('scripts/db-test/run-all.sh').includes('run "' + s + '"'), s);
});
t('no function may be called _r434_* (0434\'s own check row counts them); every _r436_ function is revoked and definer', () => {
  const fns = [...MIG.matchAll(/create or replace function public\.(\w+)\([^]*?\nreturns [^\n]*\n/g)];
  assert.deepEqual(fns.map((f) => f[1]).filter((n) => n.startsWith('_r434_')), ['_r434_tg_start_now']);
  for (const f of fns) { assert.ok(/security definer set search_path = ''/.test(f[0]), f[1]); if (f[1].startsWith('_r436_')) assert.ok(MIG.includes("'public." + f[1] + '('), f[1]); }
});
t('the rows it updates are its own, the queue rows it made, and the check (the same columns as verify_task)', () => {
  const ups = [...CODE.matchAll(/\bupdate public\.(\w+)/g)].map((m) => m[1]).sort();
  assert.deepEqual([...new Set(ups)], ['assign_notify_outbox', 'event_tasks', 'staff_update_outbox', 'task_start_notices']);
  assert.equal(ups.filter((x) => x === 'event_tasks').length, 1);
});
t('supervisor rule: role, section + event, never own task, reason, pending only; others go to the 0311 check', () => {
  const b = MIG.slice(MIG.indexOf('function public._r436_verify_task'), MIG.indexOf('create or replace function public.verify_task'));
  assert.match(b, /<> 'supervisor' then return public\._r311_verify_task\(p_id, p_pass, p_note\)/);
  for (const re of [/has_area\('staff', 'view'\)/, /_r436_sup_can\(t, auth\.uid\(\)\)/, /status is distinct from 'completed' or t\.verify_status is distinct from 'pending'/, /r436_reason/, /org_id = public\.current_org_id\(\) for update/]) assert.match(b, re);
});
t('e-mail: the owner\'s subject, who / when, task, start, place, task page; text + HTML', () => {
  const m = staffUpdateMessage(ROW, ORIGIN), h = staffUpdateHtml(ROW, ORIGIN);
  assert.equal(m.subject, 'You can start now: Flowers (Rao wedding)');
  for (const s of ['Stage set-up - done by Anu Rao at 3:40 PM on 25 Nov 2026', 'Your task: Flowers (Decor)', 'Start time: 4:00 PM on 25 Nov 2026', 'Place: Taj Krishna',
    ORIGIN + '/work.html?staff=' + 'a'.repeat(64) + '&event=a0000000-0000-4000-8000-00000000da01', 'Just reply to this e-mail']) assert.ok(m.text.includes(s), s);
  assert.ok(!/changed something|Update:/.test(m.subject + m.text));
  for (const s of ['You can start now', 'Anu Rao', 'Taj Krishna', 'Open my task page', 'you are on the staff list']) assert.ok(h.includes(s), s);
});
t('rework: Please hold; go on; several; other changes follow; cancelled earlier task', () => {
  const hold = { ...ITEM, type: 'hold', line: 'Please hold: Flowers - Stage set-up needs rework', earlier_state: 'rework', by: 'Mia' };
  const m = staffUpdateMessage({ ...ROW, changes: [hold.line, 'Flowers: instructions updated'], start_now: [hold] }, ORIGIN);
  assert.equal(m.subject, 'Please hold: Flowers (Rao wedding)');
  assert.ok(m.text.includes('Stage set-up - needs rework, checked by Mia') && m.text.includes('Also changed on your work:\n  - Flowers: instructions updated') && !m.text.includes('press Start'));
  const go = { ...ITEM, type: 'go_on', task: 'Lights', line: 'x' };
  assert.equal(staffUpdateMessage({ ...ROW, start_now: [go] }, ORIGIN).subject, 'You can go on now: Lights (Rao wedding)');
  assert.equal(staffUpdateMessage({ ...ROW, start_now: [hold, ITEM, { ...ITEM, task: 'Lamps' }] }, ORIGIN).subject, 'You can start now: Flowers and 1 more (Rao wedding)');
  assert.ok(staffUpdateMessage({ ...ROW, start_now: [{ ...ITEM, earlier_state: 'cancelled' }] }, ORIGIN).text.includes('Stage set-up - cancelled by Anu Rao'));
  assert.ok(!staffUpdateMessage({ ...ROW, start_now: [{ ...ITEM, start: null, day: null, by: null }] }, ORIGIN).text.includes('Start time'));
});
t('degrades: no start_now (old SQL), rubbish facts, a cancelled event = the R172 words, never a lost e-mail', () => {
  for (const start_now of [undefined, null, 'x', [], [null], [{ type: 'evil', task: 'a', earlier: 'b' }], [{ type: 'constructor', task: 'a', earlier: 'b' }], [{ type: 'start_now' }]]) {
    const m = staffUpdateMessage({ ...ROW, start_now }, ORIGIN);
    assert.equal(m.subject, 'Update: your tasks for Rao wedding on 25 Nov 2026 changed'); assert.ok(m.text.includes('  - ' + LINE));
  }
  assert.deepEqual(startItems({ ...ROW, cancelled: true }), []);
  assert.ok(MIG.includes("kind stays task_update"), 'the claim keeps the kind an older sender knows');
});
t('safe text: markup and line breaks in names never reach the subject / HTML as such', () => {
  const r = { ...ROW, event: 'Rao\r\nBcc: x', start_now: [{ ...ITEM, task: '<b>x</b>\r\nTo: y', by: '"><script>' }] };
  const m = staffUpdateMessage(r, ORIGIN); assert.ok(!/[\r\n<>]/.test(m.subject)); assert.ok(!/<script>|<b>x/.test(staffUpdateHtml(r, ORIGIN)));
});
t('WhatsApp: "please hold" fits the existing template', () => {
  const c = fieldContent('staff_task_changed', ['Ravi', 'Flowers', 'Rao wedding', 'please hold - Stage set-up needs rework'], '');
  assert.equal(c.template.components[0].parameters[3].text, 'please hold - Stage set-up needs rework');
});
t('task pages: the words, only on open tasks; Start asks, never blocks; nothing else asks', async () => {
  const wait = { title: 'Stage set-up', done: false, state: 'waiting' };
  assert.deepEqual(W.info(wait, 'assigned'), { kind: 'waiting', text: 'Waits for Stage set-up (not done yet)' });
  assert.equal(W.info({ ...wait, state: 'rework' }, 'in_progress').text, 'Stage set-up needs rework - please hold');
  assert.equal(W.info({ title: 'Stage set-up', done: true, state: 'done' }, 'accepted').text, 'You can start now - Stage set-up is done');
  assert.equal(W.info({ title: 'Stage set-up', done: true }, 'accepted').kind, 'released');   // before 0436
  assert.equal(W.info({ title: 'S', done: true, state: 'cancelled' }, 'assigned').text, 'You can start now - S was cancelled');
  for (const s of ['completed', 'cancelled', 'rejected']) assert.equal(W.info(wait, s), null);
  assert.equal(W.info(null, 'assigned'), null); assert.equal(W.info({ title: 'S', done: true, state: 'done' }, 'in_progress'), null);
  const asked = []; globalThis.BPUI = { confirm: async (m, o) => { asked.push([m, o.okLabel]); return asked.length === 1; } };
  assert.equal(await W.okToStart(wait, 'start', 'accepted'), true); assert.equal(await W.okToStart(wait, 'start', 'accepted'), false);
  assert.equal(await W.okToStart(wait, 'accept', 'assigned'), true); assert.equal(await W.okToStart({ title: 'S', done: true, state: 'done' }, 'start', 'accepted'), true); assert.equal(await W.okToStart(null, 'start', 'accepted'), true);
  delete globalThis.BPUI;
  assert.deepEqual(asked, [['Stage set-up is not done yet. Start anyway?', 'Start anyway'], ['Stage set-up is not done yet. Start anyway?', 'Start anyway']]);
});
t('wired: work page, permanent link, run-sheet; no new poller; no inline style / HTML strings in task-waits.js', () => {
  const js = read('public/task-waits.js'), work = read('public/work.html'), home = read('public/staff-home.js'), run = read('public/runsheet.html');
  assert.ok(!/innerHTML|setInterval|setTimeout|\.style\b/.test(js));
  for (const s of [work, run]) assert.ok(/task-waits\.js\?v=/.test(s) && /task-waits\.css\?v=/.test(s) && /HelmTaskWaits\.okToStart/.test(s) && /HelmTaskWaits\.decorate/.test(s));
  assert.ok(/waits_for:t\.waits_for\|\|null/.test(work), 'offline view keeps the line');
  assert.ok(/HelmTaskWaits\.decorate\(box, t\.waits_for, st\)/.test(home) && /visibilitychange/.test(home) && !/setInterval/.test(home));
  assert.ok(/location\.hash==="#my-tasks"/.test(run));
});
t('bell: start / hold opens the person\'s own tasks, the office rows keep the monitor; the same rule in the WhatsApp copy', () => {
  const rule = 'if (k === "task_escalated" && (d.via === "start_now" || d.via === "hold")) return "runsheet.html?quote=" + enc(q) + "#my-tasks";';
  for (const p of ['public/store-api.js', 'supabase/functions/comms-dispatch/deeplink.js']) { const s = read(p); assert.ok(s.includes(rule), p); assert.ok(s.indexOf(rule) < s.indexOf('if (k === "task_escalated") return "monitor.html'), p); }
});

let bad = 0;
for (const [name, fn] of tests) { try { await fn(); console.log('  ok  ' + name); } catch (e) { bad++; console.error('  FAIL ' + name + '\n       ' + (e && e.message)); } }
console.log(bad ? 'r253-start-now-mail: ' + bad + ' FAILED' : 'r253-start-now-mail: ' + tests.length + ' passed');
process.exit(bad ? 1 : 0);
