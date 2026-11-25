// R261-C: Resources = 1 Inventory 2 Vendors 3 Tasks & Crew (assign only) 4 Budget; no Builder in the Tasks header; Go to the event on Wrap-up;
// the cost lines; closing on the event day once the event is marked complete (0451).
import test from 'node:test'; import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs'; import { createRequire } from 'node:module';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8'), require = createRequire(import.meta.url);
const EV = read('public/event.html'), OPS = read('public/ops.html'), BRD = read('public/ops-board.js'), CSS = read('public/ops-board.css'), ST = read('public/event-steps.js'), CL = read('public/closure.html');
test('Resources: step 2 is Vendors (their page), What\'s missing is its second button; without the Vendors page the resource plan stays', () => {
  assert.match(EV, /mods:\["inventory","vendors","tasks","budget"\],steps:true/); assert.match(EV, /\{t:"Open vendors", href:"vendors\.html\?tab=requests&quote="[^}]*primary:true\}, \{t:"What's missing", href:"resources\.html\?quote="/);
  assert.match(EV, /if\(cardDenied\.has\("vendors"\)\) recommended=recommended\.map\(k=>k==="vendors"\?"resourceplan":k\)/);
});
test('Tasks & Crew from Resources opens with the assigning part only, on Pre-event, with a way to the full page', () => {
  assert.match(EV, /assignHash=\(\)=>\["confirmed","planning","resources"\]\.includes/); const R = require('../public/resource-steps.js'); assert.equal(R.href('people', 'q1'), 'ops.html?quote=q1#assign'); assert.equal(R.href('stock', 'q1'), 'inventory.html?quote=q1');
  assert.match(OPS, /id="tcAssign"[^>]*hidden/); assert.match(OPS, /id="tcAssignAll">Open the event-day page/); assert.match(BRD, /S\.openStep = S\.assign \|\| /); assert.match(BRD, /setAssign\(global\.location\.hash === "#assign"\)/);
  assert.match(CSS, /\.tc\.is-assign :is\(#tcSteps,#tcPreTop,#tcPreCheck,#tcLock,#tcWrap\)\{display:none\}/); assert.match(CSS, /\.tc\.is-assign #tcFlow>:not\(#work\):not\(#tcCrewCard\):not\(#tcPlanRem\)\{display:none\}/);
  assert.doesNotMatch(OPS, /<nav class="nav">.*Builder/);
});
test('Wrap-up has "Go to the event" after the three next pages', () => { assert.match(ST, /"data-key": "next:event", href: "event\.html\?id=" \+ enc\(qid\(ctx\)\), text: "Go to the event →"/); });
test('cost lines: the Void button has room for its word', () => { const b = read('public/budget-polish.css'); assert.match(b, /\.bp-table \.c-x\{width:76px\}/); assert.match(b, /\.bp-table td:last-child \.rm\{white-space:nowrap/); });
test('close today: only when the server says the day counts as over; the failing line leads to Mark event complete', () => {
  assert.match(CL, /if\(d===BPStore\.todayLocal\(\) && review && review\.too_early===false\) return "";/); assert.match(read('public/closure-checklist.js'), /doneGo \? "Mark event complete \(Wrap-up\)"/);
  const q = read('supabase/migrations/0451_r261_close_same_day.sql'); assert.match(q, /q\.lifecycle_stage = 'settlement'/); assert.match(q, /q\.event_date = public\._a198_org_today\(q\.org_id\)/); assert.doesNotMatch(q, /\b(drop table|delete from|truncate)\b/i);
  assert.ok(read('supabase/APPLY-0451.sql').includes(q), 'APPLY = the migration');
});
