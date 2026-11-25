// R261-A: chairs drawn = seats counted, Helm green client pages, the Done card + "Event confirmed", the event time, the invitation footer
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const FLOW = read('public/flow.html'), DONE = require('../public/flow-done.js'), BK = read('public/booklet.js'), PT = read('public/portal.html'), AP = read('public/approve.html');
const full = { client: true, date: true, time: true, guests: 100, venue: true, menu: true, layout: true, quote: true, plan: true, approved: true, advance: true, discovery: true, reqs: true, proposal: true };

test('A1: the auto layout spreads every seat over the tables, and 2D / 3D draw one chair per seat', () => {
  const B = read('public/builder.js'), T = read('public/builder-3d.js');
  assert.match(B, /base=even\?Math\.floor\(\(N\|\|80\)\/n\):0, extra=even\?\(N\|\|80\)%n:0/);
  const N = 70, n = Math.ceil(N / 8), base = Math.floor(N / n), extra = N % n, seats = Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
  assert.deepEqual(seats, [8, 8, 8, 8, 8, 8, 8, 7, 7]); assert.equal(seats.reduce((a, b) => a + b, 0), 70);
  assert.match(B, /for\(let s=0;s<seats;s\+\+\)\{\s*const ang=s\/seats/); assert.match(T, /for\(let s=0;s<seats;s\+\+\)\{ const a=s\/seats\*Math\.PI\*2[^\n]*\n[^\n]*\n\s*chairs\.push/);
});
test('A2: booklet and client page are in Helm green for every studio; logo and name stay', () => {
  for (const x of [BK, PT, AP]) assert.doesNotMatch(x, /setProperty\(["']--accent/);
  assert.match(read('public/booklet.css'), /--accent:#047857/); assert.match(PT, /--accent:#047857/); assert.match(AP, /--accent:#047857/);
  assert.match(BK, /safeLogo\(s\.logo\)/); assert.match(PT, /BPStore\.paintStudio\(d\.studio\)/);
});
test('A3: what is missing is listed, the plan is not asked for when it cannot be seen, optional steps never count', () => {
  const s = DONE.summary(full); assert.equal(s.ready, true); assert.equal(s.confirmed, true); assert.equal(s.missing.length, 0); assert.equal(s.total, 11);
  const m = DONE.summary({ ...full, time: false, guests: 0, advance: false }); assert.deepEqual(m.missing.map((i) => i.key), ['time', 'guests', 'advance']); assert.equal(m.ready, false); assert.equal(m.confirmed, false);
  const o = DONE.summary({ ...full, proposal: false, discovery: false }); assert.equal(o.ready, true); assert.deepEqual(o.optional.map((i) => i.key), ['discovery', 'proposal']);
  assert.equal(DONE.summary({ ...full, plan: null }).total, 10); assert.equal(DONE.summary({ ...full, plan: false }).ready, false);
  assert.equal(DONE.summary({ ...full, cancelled: true }).ready, false); assert.equal(DONE.summary({}).done, 0);
  for (const i of DONE.items(full)) { assert.match(FLOW, new RegExp('id="' + i.href.slice(1) + '"'), i.key); if (i.focus) assert.match(FLOW, new RegExp('id="' + i.focus + '"'), i.focus); }
});
test('A3: it saves nothing, amounts follow Hide amounts, Esc closes, reduced motion is calm, no HTML strings', () => {
  const src = read('public/flow-done.js'), css = read('public/flow-done.css');
  assert.doesNotMatch(src, /innerHTML|insertAdjacentHTML|BPStore|fetch\(|\.rpc\(|setTimeout|new Audio|localStorage/);
  assert.match(src, /data-money/); assert.match(src, /e\.key === "Escape"/); assert.match(src, /aria-modal/); assert.match(css, /prefers-reduced-motion:reduce/);
  assert.match(FLOW, /updateProgress\(\); nextShare\(\); \}/); assert.doesNotMatch(FLOW, /celebrateAdvance/);   // R262: after the payment comes sharing; Done plays the tick
});
test('A4: the event time is in step 1, saved only when changed here, never as a half-typed blank', () => {
  assert.match(FLOW, /<input id="c_time" type="time">/); assert.match(FLOW, /client:\["c_name"[^\]]*"c_date","c_time"/);
  assert.match(FLOW, /if\(tmNew!==origTime\) patch\.eventTime=tmNew\|\|null;/); assert.match(FLOW, /validity\.badInput \? origTime : x\.value/);
  assert.match(FLOW, /qprev-when/); assert.match(FLOW, /\$\{whenNow\(\)\?`<div style="margin-top:2px">\$\{esc\(whenNow\(\)\)\}<\/div>`:''\}/);
  assert.match(FLOW, /id="csTime"[\s\S]{0,220}Set the event time/);
  const send = FLOW.slice(FLOW.indexOf('async function sendApproval'), FLOW.indexOf('async function sendApproval') + 2600); assert.doesNotMatch(send, /c_time|timeTyped/, 'a reminder, never a block');
});
test('A4: the time is on the booklet cover and facts, the approval page and the client page; the databases already send it', () => {
  assert.match(BK, /e\.event_date \? fmtTime\(e\.start_time \|\| e\.event_time\) : ""/); assert.match(BK, /fact\(dl, "Time"/);
  assert.match(AP, /id="when" hidden/); assert.match(AP, /HC\.formatEventDate\(cc, String\(d\), q\.event_time\|\|""\)/); assert.match(PT, /fmtWhen\(e\.event_date,e\.event_time\)/);
  assert.match(read('supabase/migrations/0065_client_booklet.sql'), /'event_time', q\.event_time/); assert.match(read('supabase/migrations/0437_r254_e2e_fixes.sql'), /'event_time', to_jsonb\(q\) -> 'event_time'/);
});
test('A4: the invitation offers the event date / time when it differs and changes nothing by itself', () => {
  const st = read('public/invite-studio.html');
  assert.match(st, /id="whenSync" role="status" hidden/); assert.match(st, /n\.hidden=readOnly \|\| !\(dOff\|\|tOff\)/); assert.match(st, /\$\("#whenSyncBtn"\)\.addEventListener\("click",useEventWhen\)/);
  const HC = require('../public/country-profile.js'); assert.equal(HC.toHHMM('7:00 PM'), '19:00'); assert.equal(HC.toHHMM('19:00:00'), '19:00');
});
