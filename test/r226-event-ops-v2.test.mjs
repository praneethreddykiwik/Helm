// R226: event operations v2 (EVENT-OPS-PLAN-V2.md) - the day before + the event day organised.
//   1 HelmTaskStatus.opsWindow: Before the event / Day before / On the day / Wrap-up from the studio clock (both pages)
//   2 HelmEventPlan.schedule: the backward schedule (latest start = Ready by - duration x (1 + buffer) through "needs first";
//     a loop never hangs; the same numbers as the 0396 server test), the forward "ready around" estimate, Ready by fallback
//   3 the pages: four windows on BOTH Tasks & Crew and the monitor, the shared cards, hidden before 0396, Remind menu
//     (Bell / E-mail / WhatsApp), proof photo beside Done, Open = drawer, bigger tabs, theme tokens only
//   4 safety: 0396 additive (no drop / delete / truncate), bell only, versions + tours + MANIFEST + APPLY checks
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); } };
const TSJS = read('public/task-status.js'), EPJS = read('public/event-plan.js'), BRD = read('public/ops-board.js'), MON = read('public/monitor.js');
const OPS = read('public/ops.html'), MONH = read('public/monitor.html'), EPCSS = read('public/event-plan.css'), MONCSS = read('public/monitor.css');
const TOURS = read('public/page-tours.js'), STORE = read('public/store-api.js'), SQL = read('supabase/migrations/0396_r226_event_day_plan.sql');
const APPLY = read('supabase/APPLY-0396.sql'), MAN = read('supabase/migrations/MANIFEST'), RUNALL = read('scripts/db-test/run-all.sh');

const base = { Intl, Date, Math, Number, String, Object, Array, JSON, isFinite, isNaN, Infinity, Promise, setInterval() {}, clearInterval() {} };
const W = {}; vm.runInNewContext(TSJS, Object.assign({ window: W }, base));
const TS = W.HelmTaskStatus;
const W2 = { HelmTaskStatus: TS }; vm.runInNewContext(EPJS, Object.assign({ window: W2 }, base));
const EP = W2.HelmEventPlan;
const tz = 'Asia/Kolkata', at = (iso) => Date.parse(iso);
const EV = { eventDate: '2026-11-21', eventTime: '7:00 PM', stage: 'ready', status: 'confirmed', tz, runsheet: [], tasks: [{ status: 'accepted', planned_start: '2026-11-21T03:30:00Z' }] };
const win = (now, o) => { const m = TS.opsMode(Object.assign({}, EV, o || {}, { now: at(now) })); return TS.opsWindow(m, Object.assign({}, EV, o || {}, { now: at(now) })); };

await t('1a R251 steps from the studio clock + the stage: Day before -> Pre-event -> On the event -> Wrap-up', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(TS.WINDOWS.map((w) => w[0] + ':' + w[1]))), ['daybefore:Day before', 'pre:Pre-event', 'onday:On the event', 'wrapup:Wrap-up']);
  assert.deepEqual(JSON.parse(JSON.stringify(TS.STEPS.map((w) => w[0]))), ['daybefore', 'pre', 'onday'], 'Wrap-up is no step tab');
  assert.equal(win('2026-11-16T12:00:00Z'), 'daybefore');
  assert.equal(win('2026-11-20T18:29:00Z'), 'daybefore', '11:59 PM IST the evening before');
  assert.equal(win('2026-11-20T18:31:00Z'), 'pre', '12:01 AM IST on the event day');
  assert.equal(win('2026-11-21T05:00:00Z'), 'pre', 'set-up is running, nobody marked pre-event complete');
  assert.equal(win('2026-11-21T05:00:00Z', { stage: 'event_day' }), 'onday', 'pre-event complete = the stage is Event Day');
  assert.equal(win('2026-11-21T13:31:00Z'), 'onday', 'guests (7 PM IST) are in: never stuck on set-up');
  assert.equal(win('2026-11-21T13:31:00Z', { eventTime: '' }), 'pre', 'no guests time: waits for the mark');
  assert.equal(win('2026-11-16T12:00:00Z', { stage: 'event_day' }), 'daybefore', 'the stage alone, days early, never reads as live');
  assert.equal(win('2026-11-22T18:00:00Z'), 'wrapup', 'the day is over');
  assert.equal(win('2026-11-21T05:00:00Z', { stage: 'settlement' }), 'wrapup');
  assert.equal(win('2026-11-20T05:00:00Z', { status: 'cancelled' }), 'daybefore');
  assert.equal(win('2026-11-20T05:00:00Z', { eventDate: '' }), 'daybefore');
});
await t('1b each step maps to the R222 two-mode rule; old hand picks land on a step', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(TS.WIN_PHASE)), { daybefore: 'plan', pre: 'live', onday: 'live', wrapup: 'live' });
  assert.ok(TS.winOk('daybefore') && TS.winOk('pre') && !TS.winOk('plan') && !TS.winOk('wrapup') && !TS.winOk('__proto__') && !TS.winOk(null));
  assert.deepEqual(['plan', 'before', 'live', 'wrapup', 'pre', 'zz', '__proto__', null].map((x) => TS.normWin(x)), ['daybefore', 'daybefore', 'onday', 'onday', 'pre', null, null, null]);
  assert.equal(TS.stepOf('wrapup'), 'onday'); assert.equal(TS.stepOf('pre'), 'pre');
});
await t('1c R251 which step a task belongs to: by its time, else its words; counts per step', () => {
  const o = { eventDate: '2026-11-21', eventTime: '7:00 PM', tz }, st = (title, start, category) => TS.taskStep({ title, category, planned_start: start }, o);
  assert.equal(st('Load the truck', '2026-11-20T10:00:00Z'), 'daybefore');
  assert.equal(st('Stage set-up', '2026-11-21T03:30:00Z'), 'pre');
  assert.equal(st('Dinner service', '2026-11-21T14:30:00Z'), 'onday');
  assert.equal(st('Pack and load rentals', '2026-11-21T18:00:00Z', 'Teardown'), 'wrapup');
  assert.equal(st('Return the linen', '2026-11-22T06:00:00Z'), 'wrapup');
  assert.equal(st('PA system setup'), 'pre'); assert.equal(st('Water & welcome drinks'), 'onday'); assert.equal(st('Anything', null, 'Teardown'), 'wrapup');
  const b = TS.bySteps([{ title: 'a', status: 'completed', crew_id: 1 }, { title: 'b', status: 'unassigned' }, { title: 'x', status: 'cancelled' }, { title: 'Valet', status: 'assigned', crew_id: 2 }], o);
  assert.deepEqual([b.pre.total, b.pre.done, b.pre.open, b.pre.unassigned, b.onday.total, b.wrapup.total], [2, 1, 1, 1, 1, 0]);
});

// the SAME example as tests/db/r226-event-day-plan-0396.sql #13: Ready by 17:00 IST, buffer 15 %
const ready = TS.wallMs('2026-11-21', 17 * 60, tz);
const A = { id: 'a', title: 'Stage set-up', status: 'assigned', duration_min: 120 }, Bt = { id: 'b', title: 'Stage flowers', status: 'accepted', duration_min: 60, depends_on: 'a' }, C = { id: 'c', title: 'Welcome board', status: 'assigned' };
const ist = (ms) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
await t('2a backward schedule: flowers by 15:51, stage by 13:33 (finish 15:51), the welcome board is not timed (same as 0396)', () => {
  const sc = EP.schedule([A, Bt, C], { readyAt: ready, bufPct: 15, now: at('2026-11-21T03:00:00Z') });
  const by = Object.fromEntries(sc.rows.map((r) => [r.t.id, r]));
  assert.equal(sc.rows.length, 2); assert.equal(ist(by.b.ls), '15:51'); assert.equal(ist(by.a.ls), '13:33'); assert.equal(ist(by.a.lf), '15:51');
  assert.equal(sc.untimed.map((x) => x.id).join(), 'c'); assert.equal(by.b.need.id, 'a');
  assert.deepEqual(sc.rows.map((r) => r.t.id), ['a', 'b'], 'sorted by latest start');
});
await t('2b a loop in "needs first" never hangs: both timed from Ready by (stage 14:42, flowers 15:51)', () => {
  const sc = EP.schedule([Object.assign({}, A, { depends_on: 'b' }), Bt], { readyAt: ready, bufPct: 15, now: 0 });
  assert.deepEqual(sc.rows.map((r) => ist(r.ls)).sort(), ['14:42', '15:51']); assert.ok(sc.rows.every((r) => r.loop));
});
await t('2c states: ok -> soon (30 min before) -> late; started / done; behind estimate; venue too late', () => {
  const st = (now, extra) => EP.schedule([Object.assign({}, A, extra || {}), Bt], { readyAt: ready, bufPct: 15, remindMin: 30, now: at(now) }).rows[0].state;
  assert.equal(st('2026-11-21T07:00:00Z'), 'ok');      // 12:30 IST
  assert.equal(st('2026-11-21T07:40:00Z'), 'soon');    // 13:10 IST, latest start 13:33
  assert.equal(st('2026-11-21T08:10:00Z'), 'late');    // 13:40 IST
  assert.equal(st('2026-11-21T08:10:00Z', { status: 'in_progress', started_at: '2026-11-21T08:05:00Z' }), 'started');
  assert.equal(st('2026-11-21T08:10:00Z', { status: 'completed', completed_at: '2026-11-21T08:09:00Z' }), 'done');
  const late = EP.schedule([A, Bt], { readyAt: ready, bufPct: 15, now: at('2026-11-21T09:00:00Z') });   // 14:30 IST: 138 + 69 min -> 17:57
  assert.equal(late.behindMin, 57); assert.equal(late.late, 1, 'only the stage is past its latest start');
  const venue = EP.schedule([A, Bt], { readyAt: ready, venueAt: TS.wallMs('2026-11-21', 14 * 60, tz), bufPct: 15, now: 0 });
  assert.ok(venue.rows[0].tooEarly, 'stage would have to start before the venue opens');
});
await t('2d Ready by: the plan time, else 1 h before Guests arrive; learned durations by name', () => {
  assert.equal(ist(EP.readyAt({ ready_by: '17:30' }, '2026-11-21', '19:00', tz)), '17:30');
  assert.equal(ist(EP.readyAt(null, '2026-11-21', '7:00 PM', tz)), '18:00');
  assert.ok(isNaN(EP.readyAt(null, '2026-11-21', '', tz)) && isNaN(EP.readyAt({ ready_by: '17:00' }, '', '', tz)));
  assert.equal(EP.learnedFor({ learned: [{ title: 'stage set-up', minutes: 120, n: 2 }] }, ' Stage Set-up ').minutes, 120);
  assert.equal(EP.learnedFor({ learned: [] }, 'x'), null);
  assert.equal(EP.durWords(150), '2 h 30 min'); assert.equal(EP.durWords(45), '45 min');
  assert.equal(EP.DAYBEFORE.length, 11);
  const keys = SQL.match(/select array\['vendors'[^\]]*\]/)[0].match(/'([a-z_]+)'/g).map((k) => k.slice(1, -1));
  assert.deepEqual(JSON.parse(JSON.stringify(EP.DAYBEFORE.map((d) => d[0]))), keys, 'page lines = the server keys');
});

await t('3a BOTH pages: the same three step tabs (data-win), the same shared cards, event-plan.js loaded after task-status.js', () => {
  for (const [name, html] of [['ops', OPS], ['monitor', MONH]]) {
    const wins = [...html.matchAll(/data-win="([a-z]+)"[^>]*>([^<]+)</g)].map((m) => m[1] + ':' + m[2]);
    assert.deepEqual(wins, ['daybefore:Day before', 'pre:Pre-event', 'onday:On the event'], name);
    assert.match(html, /task-status\.js\?v=\d+"><\/script>\n<script src="event-plan\.js\?v=\d+"><\/script>/, name + ' load order');
    assert.match(html, /event-plan\.css\?v=\d+/, name);
  }
  assert.match(OPS, /id="tcDayBefore"[^>]*hidden/); assert.match(OPS, /id="tcReady"[^>]*hidden/);
  assert.match(MONH, /id="monDayBefore"[^>]*hidden/); assert.match(MONH, /id="monReady"[^>]*hidden/);
  assert.match(BRD, /EP\.renderDayBefore\(dHost, planCtx\(\)\)/); assert.match(BRD, /EP\.renderReady\(rHost, planCtx\(\)\)/);
  assert.match(MON, /EP\.renderDayBefore\(dh, planCtx\(\)\)/); assert.match(MON, /EP\.renderReady\(rh, planCtx\(\)\)/);
  assert.match(BRD, /TS\.opsWindow\(S\.mode/); assert.match(MON, /TS\.opsWindow\(S\.mode/);
});
await t('3b before 0396 nothing shows and nothing breaks: dayPlan.get answers null when the call is missing; cards need a plan', () => {
  assert.ok(STORE.includes('async get(quoteId) { if (!supa || !quoteId) return null; try { return await rpc("event_day_plan_get", { p_quote: quoteId }); } catch (e) { if (rpcMissing(e)) return null; throw e; } }'), 'dayPlan.get null before 0396');
  assert.match(BRD, /card\("tcReady", !!\(EP && S\.plan\)/); assert.match(MON, /rh\.hidden = !\(EP && S\.plan/);
  assert.match(MON, /if \(S\.has396\) opts\.push\(\["bell"/, 'Bell only with 0396');
});
await t('3c monitor: no red Late board before the event; Remind = Bell / E-mail / WhatsApp; Open = drawer; proof beside Done', () => {
  assert.match(MON, /if \(!lateOn\(\)\) \{ box\.hidden = true; return; \}/, 'R251: the Late panel only while the event is running');
  assert.match(MON, /text: "Remind ▾"/); assert.doesNotMatch(MON, /text: "✉ Nudge"/);
  assert.match(MON, /BPStore\.ops\.whatsappTasks\(t\.id\)/); assert.match(MON, /BPStore\.ops\.dayPlan\.bell\(t\.id\)/); assert.match(MON, /return nudge\(t, btn\)/);
  assert.match(MON, /BPUI\.confirm\("Send “"/, 'WhatsApp asks first');
  assert.match(MON, /openDrawer\(t, o\)/); assert.match(MONH, /id="monDrawer" role="dialog" aria-modal="true"/);
  assert.match(MON, /if \(s\.key === "done"\) \{ var pt = proofThumb\(t, false\)/); assert.match(MON, /O\.evidenceUrls\(paths, 300\)/);
  assert.match(MON, /e\.key === "Escape"/); assert.match(MON, /"Edit in Tasks & Crew →"/);
  assert.match(MONCSS, /\.mon-tab\{min-height:44px;padding:10px 18px;font-size:15px\}/, 'bigger tabs');
});
await t('3d theme: new styles use the --tc-* / --m-* tokens, never a hard-coded green; DOM only (no innerHTML)', () => {
  const rules = EPCSS.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(rules, /#[0-9a-f]{3,6}\b/i, 'event-plan.css has no hex colours');
  const r226 = MONCSS.slice(MONCSS.indexOf('R226'));
  assert.doesNotMatch(r226, /#(047857|10a37a|065f46|036b4d|18a558)/i);
  for (const src of [EPJS, MON.slice(MON.indexOf('function remindBtn'))]) assert.doesNotMatch(src, /innerHTML|insertAdjacentHTML|outerHTML/);
});
await t('3e tours updated (both pages) and versions bumped above main', () => {
  assert.match(TOURS, /sel: "#monWins", title: "Where the event is"/);   // R250 step strip
  assert.match(TOURS, /Day before: tick the checklist. Ready by: each set-up job.s latest start/);
  assert.doesNotMatch(TOURS, /Nudge e-mails the task to the person again/);
  assert.match(OPS, /ops-board\.js\?v=([4-9]|\d\d)"/); assert.match(MONH, /monitor\.js\?v=([8-9]|\d\d)"/);
});

await t('4a 0396 is additive + idempotent: no drop table / column, no delete / truncate of real rows, bell only', () => {
  const code = SQL.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
  assert.doesNotMatch(code, /\bdrop\s+(table|column|function|policy)\b/i);
  assert.doesNotMatch(code, /\btruncate\b|\bdelete\s+from\b/i);
  assert.match(code, /add column if not exists duration_min/); assert.match(code, /create table if not exists public\.event_day_plans/);
  assert.doesNotMatch(code, /comms_outbox|task_wa_outbox|staff_email_outbox|assign_notify_outbox/, 'no e-mail / WhatsApp queue');
  assert.match(code, /'task_escalated', 'simulated'/, 'notify-list bell rows (0369)');
  assert.match(code, /grant execute on function public\.event_ready_alert_tick\(\) to service_role/);
});
await t('4b APPLY-0396 = the migration verbatim inside begin / commit, ends with check rows, pasteable (ASCII, no psql meta, no temp table)', () => {
  assert.ok(APPLY.includes(SQL), 'verbatim'); assert.match(APPLY, /^-- APPLY-0396/); assert.match(APPLY, /\) v\(item, ok\) order by item;\ncommit;\n$/);
  assert.equal((APPLY.match(/^begin;$/gm) || []).length, 1);
  assert.doesNotMatch(APPLY, /[^\x00-\x7f]/); assert.doesNotMatch(APPLY, /^\\/m); assert.doesNotMatch(APPLY, /create temp/i);
  assert.doesNotMatch(APPLY.slice(APPLY.lastIndexOf('select item, ok')), /event_ready_alert_tick\(\)\s*>=/, 'the checks never run the job');
  assert.match(MAN, /^forward  supabase\/migrations\/0396_r226_event_day_plan\.sql$/m);
  assert.match(RUNALL, /R226-EVENT-DAY-PLAN-0396: ALL PASS/);
});
await t('4c money never reaches these cards: no price / total / amount in event-plan.js or the plan call', () => {
  assert.doesNotMatch(EPJS, /pricing|\.total\b|amount|subtotal/i);
  const get = SQL.slice(SQL.indexOf('function public.event_day_plan_get'), SQL.indexOf('function public.event_day_plan_set'));
  assert.doesNotMatch(get, /pricing|total|amount/i);
});

console.log(`\nR226 event ops v2: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
