// R252 (owner, 24 Nov): "where is it telling that everything should be ready before an hour" - pre-check.js: the pre-event check banner,
// the bell line on the Ready by card and "How the steps work", on Tasks & Crew and the Event-day monitor. + Settings -> Users & invites.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const read = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
require('../public/task-status.js'); require('../public/event-plan.js'); require('../public/event-steps.js');
const PC = require('../public/pre-check.js'), EP = globalThis.HelmEventPlan, TS = globalThis.HelmTaskStatus;
const JS = read('public/pre-check.js'), CSS = read('public/pre-check.css'), OPS = read('public/ops.html'), MON = read('public/monitor.html');
let pass = 0, fail = 0;
const t = async (n, f) => { try { await f(); pass++; console.log('  ok ' + n); } catch (e) { fail++; console.log('  FAIL ' + n); console.log(e); } };
const EV = '2026-11-29', IST = 'Asia/Kolkata';
const at = (hm, d, off) => Date.parse((d || EV) + 'T' + hm + ':00' + (off || '+05:30'));
const ALL = Object.fromEntries(EP.DAYBEFORE.map((d) => [d[0], { done: true }]));
const T = (id, status, hm, o) => Object.assign({ id, title: id, status, crew_id: 'c-' + id, planned_start: new Date(at(hm)).toISOString() }, o || {});
const CTX = (hm, o) => { o = o || {}; return Object.assign({ quoteId: 'q1', quote: Object.assign({ eventDate: EV, eventTime: '6:00 PM', stage: 'confirmed', status: 'confirmed' }, o.quote), tasks: [T('a', 'completed', '10:00'), T('b', 'accepted', '11:00'), T('c', 'assigned', '12:00')],
  plan: { checks: {}, settings: {} }, autoWin: 'pre', win: 'pre', tz: IST, now: at(hm), sheet: { 'c-a': { in: '09:00' } } }, o, { quote: Object.assign({ eventDate: EV, eventTime: '6:00 PM', stage: 'confirmed', status: 'confirmed' }, o.quote) }); };

await t('Ready by: the plan first, else 1 h before Guests arrive; neither = no banner', () => {
  assert.equal(PC.state(CTX('16:20')).readyAt, at('17:00'), 'guests 6 PM -> 5 PM');
  assert.equal(PC.state(CTX('16:20', { plan: null })).readyAt, at('17:00'), 'no plan row (before 0396): still 1 h before guests');
  assert.equal(PC.state(CTX('13:30', { plan: { ready_by: '14:00', checks: {} } })).readyAt, at('14:00'));
  assert.equal(PC.state(CTX('13:30', { plan: { ready_by: '14:00', checks: {} }, quote: { eventTime: '' } })).readyAt, at('14:00'));
  assert.equal(PC.state(CTX('16:20', { quote: { eventTime: '' } })), null, 'no time');
  assert.equal(PC.state(CTX('16:20', { quote: { eventTime: 'evening' } })), null, 'a time that is no time');
  assert.equal(PC.state(CTX('16:20', { quote: { eventDate: '' } })), null);
});
await t('when: from 1 hour before Ready by, on the Pre-event step of the event day', () => {
  assert.equal(PC.state(CTX('15:59')), null); assert.ok(PC.state(CTX('16:00')));
  assert.equal(PC.state(CTX('16:20', { win: 'daybefore' })), null); assert.equal(PC.state(CTX('16:20', { win: 'onday' })), null);
  assert.equal(PC.state(CTX('16:20', { autoWin: 'daybefore' })), null); assert.equal(PC.state(CTX('16:20', { autoWin: 'wrapup' })), null);
  assert.ok(PC.state(CTX('18:30', { autoWin: 'onday' })), 'guests are due, not marked, looking at Pre-event: still there');
  assert.equal(PC.state(CTX('16:20', { quoteId: 'all' })), null);
});
await t('levels: amber with something open, calm with nothing open, red once Ready by has passed', () => {
  assert.equal(PC.state(CTX('16:20')).level, 'amber'); assert.equal(PC.state(CTX('16:59')).level, 'amber');
  const done = { tasks: [T('a', 'completed', '10:00')], plan: { checks: ALL } };
  assert.equal(PC.state(CTX('16:20', done)).level, 'calm'); assert.equal(PC.state(CTX('16:20', done)).open, 0);
  assert.equal(PC.state(CTX('17:00')).level, 'red'); assert.equal(PC.state(CTX('17:30', done)).level, 'red', 'nothing open but not marked');
});
await t('timer: h + min far out, mm:ss in the last 15 min before Ready by and in the last hour before guests', () => {
  const L = (hm) => PC.words(PC.state(CTX(hm)), IST).left;
  assert.deepEqual([L('16:20').label, L('16:20').at, L('16:20').mmss], ['Ready by in', at('17:00'), false]);
  assert.equal(L('16:45').mmss, false, 'exactly 15 min'); assert.equal(L('16:46').mmss, true); assert.equal(L('17:02').mmss, true);
  assert.equal(PC.words(PC.state(CTX('15:30', { plan: { ready_by: '15:00' } })), IST).left.mmss, false, 'red, guests still 2 h 30 min away');
  assert.equal(PC.mmss(58 * 60000 + 12000), '58:12'); assert.equal(PC.mmss(9000), '0:09'); assert.equal(PC.mmss(-5), '0:00');
  const code = JS.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(code, /setAttribute\("role", "timer"\); n\.setAttribute\("aria-live", "off"\)/); assert.match(code, /left\.mmss && !calmMotion\(\) \? mmss/); assert.equal((code.match(/setInterval\(/g) || []).length, 1, 'one clock');
});
await t('red: whatever step is looked at, from Ready by until marked; guests due = started', () => {
  for (const win of ['daybefore', 'pre', 'onday']) assert.equal(PC.state(CTX('17:00', { win })).level, 'red', win);
  assert.equal(PC.state(CTX('17:59')).started, false); assert.equal(PC.state(CTX('18:00', { autoWin: 'onday' })).started, true);
  assert.equal(PC.state(CTX('18:05', { plan: { ready_by: '19:00' }, autoWin: 'onday' })).level, 'red', 'a Ready by after the guests: red once they are due');
  assert.equal(PC.state(CTX('19:00', { autoWin: 'wrapup' })), null, 'the day is over');
});
await t('what is open, the most important first: turned down, nobody, late, not checked in, checks, the rest', () => {
  const x = CTX('16:30', { tasks: [T('Lights', 'in_progress', '15:00'), T('Buffet', 'accepted', '15:30'), T('Stage', 'accepted', '14:00'), T('Sound', 'unassigned', '15:00', { crew_id: null }), T('Drape', 'rejected', '12:00')], sheet: { 'c-Lights': { in: '09:00' } },
    nameOf: (t) => ({ Buffet: 'Ravi', Stage: 'Asha', Drape: 'Imran', Lights: 'Meena' }[t.title] || 'Not assigned'), plan: { checks: Object.assign({}, ALL, { power: {} }) } });
  assert.deepEqual(PC.items(x).map((i) => i.text), ['Drape - turned down by Imran', 'Sound - nobody on it', 'Stage - 2 h 30 min late, Asha', 'Buffet - 1 h late, Ravi', 'Ravi - not checked in', 'Asha - not checked in',
    'Power and generator confirmed - not ticked', 'Lights - not done yet, Meena']);
  assert.ok(!PC.items(Object.assign({}, x, { sheet: undefined })).some((i) => i.kind === 'away'), 'check-ins not known: nobody is called absent');
});
await t('marked (Event Day or later) or cancelled: gone', () => {
  for (const stage of ['event_day', 'settlement', 'closed']) assert.equal(PC.state(CTX('17:30', { quote: { stage } })), null, stage);
  assert.equal(PC.state(CTX('17:30', { quote: { status: 'cancelled' } })), null);
});
await t('words: the owner\'s sentence, counts from the same summary as the card', () => {
  const s = PC.state(CTX('16:20')), w = PC.words(s, IST);
  assert.equal(w.title, 'Guests arrive at 6:00 PM - in 1 h 40 min.');
  assert.equal(w.text, 'Pre-event check by 5:00 PM: 2 tasks open, 2 people not checked in, 11 day-before checks not ticked.');
  const one = PC.words(PC.state(CTX('16:20', { tasks: [T('a', 'accepted', '10:00')], sheet: {}, plan: { checks: Object.assign({}, ALL, { power: { done: false } }) } })), IST).text;
  assert.equal(one, 'Pre-event check by 5:00 PM: 1 task open, 1 person not checked in, 1 day-before check not ticked.');
  const noSheet = PC.words(PC.state(CTX('16:20', { sheet: undefined })), IST).text; assert.doesNotMatch(noSheet, /checked in/, 'check-ins not known: not claimed');
  const r = PC.words(PC.state(CTX('17:25')), IST);
  assert.equal(r.title, 'Pre-event is not complete - guests arrive in'); assert.equal(r.left.at, at('18:00'));
  assert.match(r.text, /^The pre-event check was due by 5:00 PM\. 2 tasks open, 2 people not checked in/);
  const g = PC.words(PC.state(CTX('18:20', { autoWin: 'onday', win: 'onday' })), IST);
  assert.equal(g.title, 'Guests are due - the event has started without pre-event being marked complete'); assert.equal(g.left, null); assert.match(g.text, /^Guests were due at 6:00 PM, 20 min ago\./);
  assert.equal(PC.words(PC.state(CTX('13:30', { plan: { ready_by: '14:00' }, quote: { eventTime: '' } })), IST).title, 'Everything should be ready by 2:00 PM.');
  assert.equal(PC.words(PC.state(CTX('14:30', { plan: { ready_by: '14:00' }, quote: { eventTime: '' } })), IST).title, 'Pre-event is not complete - it was due by 2:00 PM');
});
await t('the studio\'s time zone decides, never the device', () => {
  const tz = 'America/Toronto', n = (hm) => at(hm, EV, '-05:00'), o = (hm) => Object.assign(CTX('00:00'), { tz, now: n(hm) });
  assert.equal(PC.state(o('15:59')), null); assert.equal(PC.state(o('16:20')).readyAt, n('17:00'));
  assert.equal(PC.words(PC.state(o('16:20')), tz).title, 'Guests arrive at 6:00 PM - in 1 h 40 min.');
});
await t('bell line: 0396 rules - minutes before Guests arrive, else before Ready by; off / no time / no tasks / draft say so', () => {
  const B = (o) => PC.bell(Object.assign({ plan: { settings: { enabled: true, hour_before_min: 60, notify_roles: ['manager', 'supervisor'] } }, eventDate: EV, eventTime: '6:00 PM', tz: IST, tasks: [{ status: 'assigned' }], status: 'confirmed' }, o));
  assert.equal(B().text, 'Pre-event check: a bell goes at 5:00 PM to the event manager + manager + supervisor.'); assert.equal(B().at, at('17:00'));
  assert.equal(B({ plan: { ready_by: '14:00', settings: { hour_before_min: 90, notify_roles: [] } } }).text, 'Pre-event check: a bell goes at 4:30 PM to the event manager (admins when there is none).');
  assert.equal(B({ plan: { ready_by: '14:00', settings: {} }, eventTime: '' }).at, at('13:00'));
  assert.match(B({ plan: { settings: { enabled: false } } }).text, /the bell is off for the studio/);
  assert.match(B({ eventTime: '' }).text, /no bell yet - set Guests arrive or Ready by first/);
  assert.match(B({ tasks: [{ status: 'cancelled' }] }).text, /this event has no tasks/); assert.match(B({ status: 'draft' }).text, /a draft/);
  for (const o of [{ plan: { settings: { enabled: false } } }, { eventTime: '' }, { tasks: [] }, { status: 'draft' }]) assert.equal(B(o).on, false);
  const tick = read('supabase/migrations/0396_r226_event_day_plan.sql');   // the server this line describes
  assert.match(tick, /v_start - make_interval\(mins => \(c ->> 'hour_before_min'\)::integer\)/); assert.match(tick, /coalesce\(q\.status, ''\) not in \('cancelled', 'lost', 'rejected', 'draft'\)/);
  assert.match(read('public/event-plan.js'), /PC\.bell\(\{ plan: p, eventDate: ctx\.eventDate, eventTime: ctx\.eventTime, tz: tz, tasks: ctx\.tasks, status: ctx\.status \}\)/);
});
await t('How the steps work: five lines, and each one is what task-status.js does', () => {
  assert.deepEqual(PC.STEPS.map((x) => x[0]), ['Day before', 'Pre-event', 'On the event', 'Wrap-up', 'Tasks']);
  const win = (now, o) => { const c = Object.assign({ eventDate: EV, eventTime: '6:00 PM', stage: 'confirmed', tz: IST, now }, o || {}); return TS.opsWindow(TS.opsMode(c), c); };
  assert.equal(win(at('23:59', '2026-11-28')), 'daybefore'); assert.equal(win(at('00:00')), 'pre'); assert.equal(win(at('12:00'), { stage: 'event_day' }), 'onday'); assert.equal(win(at('18:00')), 'onday'); assert.equal(win(at('09:00', '2026-11-30')), 'wrapup');
  const st = (o) => TS.taskStep(o, { eventDate: EV, eventTime: '6:00 PM', tz: IST }), iso = (x) => new Date(x).toISOString();
  assert.equal(st({ planned_start: iso(at('17:00')) }), 'pre'); assert.equal(st({ planned_start: iso(at('19:00')) }), 'onday'); assert.equal(st({ planned_start: iso(at('17:00', '2026-11-28')) }), 'daybefore');
  assert.equal(st({ title: 'Dismantle stage', planned_start: iso(at('23:00')) }), 'wrapup'); assert.equal(st({ title: 'Dinner service' }), 'onday'); assert.equal(st({ title: 'Stage set-up' }), 'pre');
});
await t('pages: banner under the step strip, how-it-works beside it, the minute clock, no read, no HTML strings', () => {
  for (const [h, pre, how, strip] of [[OPS, 'tcPreCheck', 'tcHow', 'id="tcFlow"'], [MON, 'monPreCheck', 'monHow', 'id="monSummary"']]) {
    assert.ok(h.includes('<section class="pc" id="' + pre + '" hidden></section>')); assert.ok(h.indexOf('id="' + how + '"') < h.indexOf('id="' + pre + '"') && h.indexOf('id="' + pre + '"') < h.indexOf(strip));
    assert.match(h, /\/pre-check\.js\?v=2"/); assert.match(h, /\/pre-check\.css\?v=1"/);
  }
  assert.match(read('public/ops-board.js'), /renderPlan\(\); renderPreCheck\(\); renderFlow\(\); \} \}, 60000\)/); assert.match(read('public/monitor.js'), /DLY = null; renderDelay\(\); renderPreCheck\(\); \}/);
  const code = JS.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(code, /innerHTML|insertAdjacentHTML|fetch\(|BPStore\.(?!studioLocale)|localStorage/);
  assert.match(code, /if \(seen && was !== lv\) announce\(/); assert.match(code, /card\.focus\(/); assert.match(code, /if \(b && !b\.disabled\) \{ b\.click\(\); return; \}/, 'marking = the card\'s own button');
  assert.match(code, /hid = red && !wall && hiddenFor\(q, s\.now\)/); assert.match(code, /HIDE = 600000/); assert.match(CSS, /\.pc-bar\{position:sticky;top:var\(--hb-top,0px\)/);
  assert.doesNotMatch(CSS, /#[0-9a-f]{3,8}\b/i, 'theme tokens only');
});
await t('Users & invites: short one-line chips, e-mails break only at @ and dots, one column template', () => {
  const S = require('../public/team-status.js'), NOW = at('12:00'), H = 3600000, iso = (ms) => new Date(ms).toISOString(), m = (ms) => S.member({ full_name: 'x' }, { last_sign_in_at: iso(NOW - ms) }, NOW);
  assert.equal(m(6 * H).chip, 'Active · 6 h ago'); assert.equal(m(5 * 60000).chip, 'Active · 5 min ago'); assert.equal(m(72 * H).chip, '', 'the label (Last signed in 3 days ago) is short enough');
  assert.match(m(60 * 24 * H).chip, /^Last signed in 30 Sept?(ember)?$/); assert.equal(m(6 * H).label, 'Last signed in 6 hours ago', 'View keeps the full words');
  assert.deepEqual(S.mailParts('a.b@criskasecurity.com'), ['a', '.b@', 'criskasecurity', '.com']); assert.equal(S.mailParts('a.b@c.com').join(''), 'a.b@c.com');
  const C = read('public/control.html'), TC = read('public/team-status.css');
  assert.match(C, /HelmTeamStatus\.breakMail\(tb\)/); assert.match(C, /\$\{c\.act\}\$\{c\.next\?`<div class="ucnext">/);
  assert.match(TC, /tr\.ucr>td\.ucact\{display:grid;grid-template-columns:minmax\(0,1fr\) minmax\(0,1fr\) 34px/); assert.match(TC, /tr\.ucr:hover>td\{background:transparent\}/);
});
console.log(pass + ' passed, ' + fail + ' failed'); if (fail) process.exit(1);
