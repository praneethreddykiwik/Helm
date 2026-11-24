// R227: the event-day planner + the plan lock (owner 18 Nov 2026: "Event day - add planner 2D, 3D, measure, and can print. Add
// a lock so no modifications - you need to unlock and then edit it").
//   1 HelmEventFloor (pure): seats per item (the planner's rule), the measurements (hall / usable area, stage + dance floor sizes,
//     tables, seats vs guests, aisle, walkway between seating blocks, stage to the first seats), legend, view-only links, lock words
//   2 the 2D plan SVG (room outline, hall width + length marked, no HTML strings) + the printed pack's crew call sheet
//   3 the pages: Floor plan card + lock bar on Tasks & Crew AND the monitor (hidden before 0397), the planner opens view only
//     (?view=1, 3D / Measure), a locked plan = planner / run-sheet / Ready-by edits read-only, the pack page (A4 print CSS, no
//     money, no app chrome), friendly "plan_locked" error, theme tokens only (no hard-coded green), tours <= 8 steps
//   4 safety: 0397 additive (no drop / delete / truncate of data), guards only refuse, APPLY check rows, MANIFEST + run-all wiring
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); } };
const EFJS = read('public/event-floor.js'), PKJS = read('public/eventday-pack.js'), EFCSS = read('public/event-floor.css'), PKCSS = read('public/eventday-pack.css');
const PKH = read('public/eventday-pack.html'), OPS = read('public/ops.html'), MONH = read('public/monitor.html'), BRD = read('public/ops-board.js'), MON = read('public/monitor.js');
const BJS = read('public/builder.js'), BH = read('public/builder.html'), RSH = read('public/runsheet.html'), EPJS = read('public/event-plan.js'), STORE = read('public/store-api.js');
const TOURS = read('public/page-tours.js'), SQL = read('supabase/migrations/0397_r227_event_plan_lock.sql'), APPLY = read('supabase/APPLY-0397.sql');
const MAN = read('supabase/migrations/MANIFEST'), RUNALL = read('scripts/db-test/run-all.sh'), DBT = read('tests/db/r227-plan-lock-0397.sql');

const base = { Intl, Date, Math, Number, String, Object, Array, JSON, isFinite, isNaN, Infinity, Promise, URLSearchParams };
const W = {}; vm.runInNewContext(EFJS, Object.assign({ window: W }, base));
const EF = W.HelmEventFloor;
const FLOOR = {
  world: { w: 120, h: 80 }, unit: 'ft', guests: 300, capacity: 400, hall: { len: 120, wid: 80, venue_len: 150, venue_wid: 100 },
  items: [
    { type: 'stage', category: 'structure', label: 'Main stage', x: 40, y: 2, width: 40, height: 16, rotation: 0, color: '#aa8855' },
    { type: 'dancefloor', category: 'structure', label: 'Dance floor', x: 48, y: 20, width: 24, height: 12, rotation: 0 },
    { type: 'seatblock', category: 'seating', label: 'Left', x: 20, y: 40, width: 36, height: 24, properties: { rows: 10, cols: 14 } },
    { type: 'seatblock', category: 'seating', label: 'Right', x: 64, y: 40, width: 36, height: 24, properties: { rows: 10, cols: 14 } },
    { type: 'table', category: 'seating', label: 'T1', x: 2, y: 2, width: 6, height: 6, properties: { seats: 10 } },
    { type: 'longtable', category: 'seating', label: 'Head', x: 2, y: 70, width: 16, height: 4, rotation: 90, properties: { seats: 12 } },
    { type: 'redcarpet', category: 'structure', label: 'Aisle', x: 57, y: 34, width: 6, height: 40 },
    { type: 'exit', category: 'safety', label: 'Exit', x: 108, y: 70, width: 12, height: 6 },
    { type: 'junk', x: 'a', y: 1, width: 3, height: 3 }
  ]
};

await t('1a seats per item = the planner rule (rows x cols, seats, single chairs, sofas)', () => {
  assert.equal(EF.seatsOf({ properties: { rows: 10, cols: 14 } }), 140);
  assert.equal(EF.seatsOf({ properties: { seats: 8 } }), 8);
  assert.equal(EF.seatsOf({ type: 'chiavari' }), 1);
  assert.equal(EF.seatsOf({ type: 'sofa' }), 3);
  assert.equal(EF.seatsOf({ type: 'stage' }), 0);
  // the same rule as builder.js genSeats
  assert.match(BJS, /function genSeats\(it\)\{ const p=it\.properties\|\|\{\}; if\(p\.rows&&p\.cols\) return p\.rows\*p\.cols; if\(p\.seats\) return \+p\.seats\|\|0; return SEAT_UNIT\[it\.type\]\|\|FLOOR_SEATS\[it\.type\]\|\|0; \}/);
});
await t('1b measurements: venue + usable area, stage / dance floor sizes, tables, seats vs guests, capacity, aisle, walkway, stage gap, exits', () => {
  const m = EF.measure(FLOOR), row = (k) => (m.rows.find((r) => r[0] === k) || [])[1];
  assert.equal(row('Venue'), '150 × 100 ft · 15,000 sq ft');
  assert.equal(row('Usable area (laid out)'), '120 × 80 ft · 9,600 sq ft');
  assert.equal(row('Stage'), '40 × 16 ft');
  assert.equal(row('Dance floor'), '24 × 12 ft');
  assert.equal(row('Tables'), '2 (1 round, 1 banquet)');
  assert.equal(m.seats, 302); assert.equal(row('Seats vs guests'), '302 seats for 300 guests - 2 spare');
  assert.equal(row('Venue capacity'), '400 people');
  assert.equal(row('Aisle / carpet'), '6 ft wide, 40 ft long');
  assert.equal(row('Walkway between seating blocks'), '8 ft');
  assert.equal(row('Stage to the first seats'), '22 ft');
  assert.equal(row('Exits marked'), '1');
  assert.equal(m.items, 8, 'the broken item is skipped');
  assert.equal(m.warnings.length, 0, m.warnings.join());
});
await t('1c short of seats + a tight walkway are flagged; metres shown in metres; a turned table counts its real footprint', () => {
  const f = JSON.parse(JSON.stringify(FLOOR)); f.guests = 400; f.items[3].x = 58; f.unit = 'm';
  const m = EF.measure(f);
  assert.ok(m.warnings.some((w) => /98 seats short/.test(w)), m.warnings.join());
  assert.ok(m.warnings.some((w) => /walkway between seating blocks under 4 ft/.test(w)));
  assert.equal((m.rows.find((r) => r[0] === 'Stage') || [])[1], '12.2 × 4.9 m');
  const n = EF.normalize(FLOOR), head = n.items.find((i) => i.label === 'Head');
  assert.equal(head.box.w, 4); assert.equal(head.box.h, 16);
});
await t('1d legend per category with counts; view-only planner links (2D / 3D / Measure)', () => {
  const l = EF.legend(FLOOR);
  assert.deepEqual(JSON.parse(JSON.stringify(l.map((x) => [x.label, x.n]))), [['Structure', 3], ['Seating', 4], ['Safety', 1]]);
  assert.equal(EF.viewUrl('q-1', ''), 'builder.html?quote=q-1&view=1');
  assert.equal(EF.viewUrl('q-1', '3d'), 'builder.html?quote=q-1&view=1&mode=3d');
  assert.equal(EF.viewUrl('q 1', 'measure'), 'builder.html?quote=q%201&view=1&measure=1');
});
await t('1e lock words: locked by hand / by itself, unlocked with a reason, open', () => {
  assert.equal(EF.lockWords({ locked: true, state: 'locked', changed_by: 'Sunil' }).title, 'Locked for the event day - Unlock to edit');
  assert.match(EF.lockWords({ locked: true, state: 'locked', changed_by: 'Sunil', reason: 'Final' }).sub, /^Locked by Sunil.*Final$/);
  assert.match(EF.lockWords({ locked: true, state: null, stage: 'event_day' }).sub, /Locked by itself.*Event Day stage/);
  assert.match(EF.lockWords({ locked: false, state: 'unlocked', changed_by: 'Asha', reason: 'Photo booth' }).sub, /Unlocked by Asha.*Photo booth/);
  assert.match(EF.lockWords({ locked: false, confirmed: true }).sub, /Locks by itself on the event day/);
});

// ---- 2 the SVG + the call sheet (a tiny DOM) ----
function mkDoc() {
  const mk = (tag, ns) => ({ tagName: tag, ns, attrs: {}, children: [], style: {}, textContent: '', setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k]; },
    appendChild(c) { this.children.push(c); return c; }, addEventListener() {}, get firstChild() { return this.children[0] || null; }, removeChild(c) { this.children.splice(this.children.indexOf(c), 1); } });
  return { createElement: (t) => mk(t), createElementNS: (ns, t) => mk(t, ns), createTextNode: (s) => ({ text: s }) };
}
const walk = (n, f) => { f(n); (n.children || []).forEach((c) => walk(c, f)); };
await t('2a the 2D plan: an <svg> with the room, every item, the hall width + length marked and the stage size written on it', () => {
  const d = mkDoc(), svg = EF.planSvg(d, FLOOR);
  assert.equal(svg.tagName, 'svg'); assert.match(svg.attrs['aria-label'], /hall 120 × 80 ft, 8 items/);
  let rooms = 0, shapes = 0; const texts = [];
  walk(svg, (n) => { if (n.attrs && /ef-room/.test(n.attrs.class || '')) rooms++; if (n.attrs && n.attrs.class === 'ef-shape') shapes++; if (n.tagName === 'text') texts.push(n.textContent); });
  assert.equal(rooms, 1); assert.equal(shapes, 8);
  assert.ok(texts.includes('120 ft') && texts.includes('80 ft'), texts.join('|'));
  assert.ok(texts.includes('40 × 16 ft'), 'stage size on the stage');
  assert.ok(!/innerHTML|insertAdjacentHTML/.test(EFJS + PKJS), 'DOM calls only');
});
await t('2b crew call sheet: one line per person, earliest start first, vendors marked, phone only when the row carries it', () => {
  const W2 = { HELM_PACK_NO_START: true }; vm.runInNewContext(PKJS, Object.assign({ window: W2 }, base));
  const P = W2.HelmEventdayPack;
  const cs = P.callSheet([
    { id: 'a', crew_id: 'c1', assignee_name: 'Ravi', category: 'Stage', planned_start: '2026-11-21T04:30:00Z', status: 'accepted' },
    { id: 'b', crew_id: 'c1', assignee_name: 'Ravi', category: 'Stage', planned_start: '2026-11-21T03:30:00Z', status: 'assigned' },
    { id: 'c', vendor_id: 'v1', assignee_name: 'Bloom Florists', assignee_kind: 'outsourced', category: 'Decor', status: 'accepted' },
    { id: 'd', assignee_name: 'Gone', status: 'cancelled' }
  ], [{ id: 'c1', name: 'Ravi Kumar', role: 'Supervisor', phone: '9000000001' }], {});
  assert.equal(cs.length, 2);
  assert.equal(cs[0].name, 'Ravi Kumar'); assert.equal(cs[0].tasks, 2); assert.equal(cs[0].at, Date.parse('2026-11-21T03:30:00Z')); assert.equal(cs[0].phone, '9000000001'); assert.equal(cs[0].role, 'Supervisor');
  assert.equal(cs[1].vendor, true); assert.equal(cs[1].phone, '');
  assert.equal(P.hm('18:30:00'), '6:30 PM'); assert.equal(P.addMin('23:30', 60), '12:30 AM');
});

// ---- 3 the pages ----
await t('3a Tasks & Crew + monitor: lock bar + Floor plan card, loaded through event-floor.js (hidden until 0397 answers)', () => {
  for (const [html, lock, floor] of [[OPS, 'tcLock', 'tcFloor'], [MONH, 'monLock', 'monFloor']]) {
    assert.match(html, new RegExp('<section class="ef-lock" id="' + lock + '" hidden></section>'));
    assert.match(html, new RegExp('<section class="tc-card ef-card" id="' + floor + '" aria-labelledby="' + floor + 'H" hidden></section>'));
    assert.match(html, /<script src="event-floor\.js\?v=\d+"><\/script>/); assert.match(html, /<link rel="stylesheet" href="event-floor\.css\?v=\d+">/);
  }
  assert.match(BRD, /EF\.panel\(\{ quoteId: qid\(\), lockHost: cancelled \? null : \$\("#tcLock"\), floorHost: \$\("#tcFloor"\), showFloor: !cancelled,/);   // R251: every step (On the event: below the work)
  assert.match(MON, /EF\.panel\(\{ quoteId: S\.quote, lockHost: lh, floorHost: fh, showFloor: true/);   // R251: every step (On the event: below the work)
  assert.match(STORE, /async floor\(quoteId\) \{ if \(!supa \|\| !quoteId\) return null; try \{ return await rpc\("event_floor_get", \{ p_quote: quoteId \}\); \} catch \(e\) \{ if \(rpcMissing\(e\)\) return null; throw e; \} \}/);
  assert.match(STORE, /async get\(quoteId\) \{ if \(!supa \|\| !quoteId\) return null; try \{ return await rpc\("event_plan_lock_get"/);
  assert.match(EFJS, /if \(!f \|\| !c\.lock\) \{ o\.lockHost\.hidden = true; \}/, 'no answer (before 0397) = no bar');
});
await t('3b locked = the plan editors are read-only (Ready-by times, + Add & assign, planner, run-sheet); execution untouched', () => {
  assert.match(EPJS, /var canEdit = !!p\.can_edit && !ctx\.locked/);
  assert.match(BRD, /if \(add && planLocked\(\)\) add\.hidden = true;/);
  assert.match(BRD, /locked: planLocked\(\) \};/);
  assert.match(MON, /locked: !!\(window\.HelmEventFloor && S\.quote && S\.quote !== "all" && window\.HelmEventFloor\.isLocked\(S\.quote\)\)/);
  assert.match(BJS, /r227PlanLock\(q\);/); assert.match(BJS, /const bar=applyReadonly\(null,'🔒 Locked for the event day/);
  assert.match(RSH, /if\(st && st\.locked\)\{ canEdit=false; canDelete=false; \}/);
  // Day-before ticks stay open while locked (renderDayBefore does not look at ctx.locked)
  const dayb = EPJS.slice(EPJS.indexOf('function renderDayBefore'));
  assert.ok(!/ctx\.locked/.test(dayb.slice(0, dayb.indexOf('global.HelmEventPlan'))));
});
await t('3c the planner opens VIEW ONLY from the event day (?view=1), straight into 3D or Measure', () => {
  assert.match(BJS, /if\(params\.get\('view'\)==='1'\) applyReadonly\(null,'👁 View only — opened from the event day\. 2D, 3D and Measure work; nothing is changed\.'\);/);
  assert.match(BJS, /if\(params\.get\('mode'\)==='3d'\)\{ const b3=document\.querySelector\('#viewSeg \[data-v="3d"\]'\)/);
  assert.match(BJS, /else if\(params\.get\('measure'\)==='1'\)\{ const mb=\$\('#measureBtn'\); if\(mb && !showMeasure\) mb\.click\(\); \}/);
  assert.match(BJS, /if\(RO && had\)\{ if\(customMsg\) had\.textContent=customMsg; return had; \}/, 'one bar, never two');
  assert.match(BH, /<script src="builder\.js\?v=\d+"><\/script>\n<script src="event-floor\.js\?v=\d+"><\/script>/);
  // saveLayout refuses in view-only mode (existing guard)
  assert.match(BJS, /if\(RO\)\{ if\(!silent\) toast\('View only — you can’t save'\); return false; \}/);
});
await t('3d the Event-day pack: A4 print CSS, no toolbar in print, no money, the six parts, window.print, signed-in page', () => {
  assert.match(PKCSS, /@page\{size:A4;margin:12mm\}/);
  assert.match(PKCSS, /@media print\{\n  \.pk-bar,\.pk-msg\{display:none!important\}/);
  assert.match(PKH, /<html lang="en" data-theme="light" class="auth-pending">/); assert.match(PKH, /<meta name="robots" content="noindex, nofollow">/);
  assert.ok(!/shell-proto/.test(PKH), 'no app chrome on the pack');
  for (const s of ['1 · Floor plan', '2 · Run-sheet', '3 · Crew call sheet', 'Set-up jobs', 'Day-before checklist', 'Ready by', 'Venue opens', 'Address']) assert.ok(PKJS.includes(s), s);
  assert.ok(!/pricing|\.total\b|price|amount|payment/i.test(PKJS.replace(/no prices on this sheet|never its prices|strips prices|No money|no price, total or payment|NO MONEY/gi, '')), 'the pack reads no money');
  assert.match(PKJS, /global\.print\(\)/);
  assert.match(STORE, /"event", "eventday-pack", "flow"/, 'login ?next= may return to the pack');
});
await t('3e a database refusal reads in plain words everywhere (friendlyError knows plan_locked)', () => {
  assert.match(STORE, /if \(e && \/plan_locked:\/\.test\(String\(e\.message \|\| ""\)\)\) return pre \+ "The event plan is locked for the event day\. Unlock it first \(admin or event manager, with a reason\), then try again\.";/);
});
await t('3f theme: event-floor.css / eventday-pack.css use tokens (no green hex), the dark button stays black', () => {
  const greens = /#(047857|10a37a|065f46|036b4d|0f7a43|18a558|e3f4ed|e7f6ee)\b/i;
  assert.ok(!greens.test(EFCSS) && !greens.test(PKCSS) && !greens.test(EFJS));
  assert.match(EFCSS, /\.ef-btn\.dark\{background:var\(--ef-black\);border-color:var\(--ef-black\);color:#fff\}/);
  assert.match(EFCSS, /--ef-black:var\(--tc-black,#111\)/);
});
await t('3g tours: ops / monitor / run-sheet explain the floor plan + the lock, each tour 8 steps or fewer', () => {
  const steps = (k) => { const i = TOURS.indexOf('"' + k + '": ['), j = TOURS.indexOf('\n    ],', i); return (TOURS.slice(i, j).match(/\{ sel:/g) || []).length; };
  for (const k of ['ops.html', 'monitor.html', 'runsheet.html']) assert.ok(steps(k) <= 8 && steps(k) >= 4, k + ' ' + steps(k));
  assert.match(TOURS, /\{ sel: "#evhead", [^\n]*the plan lock bar \(locked on the day; unlock = admin or event manager \+ a reason\)[^\n]*the Floor plan with 2D, 3D, Measure \(view only\) and Print pack/);
  assert.match(TOURS, /\{ sel: \["#monLock", "#monFloor"\], title: "Floor plan and the plan lock"/);
  assert.match(TOURS, /\{ sel: "#planLock", title: "Locked for the event day"/);
});

// ---- 4 safety ----
await t('4a 0397 is additive: no drop table / delete / truncate / update of rows; guards only raise; ASCII only', () => {
  const code = SQL.replace(/--[^\n]*/g, '');
  assert.ok(!/\bdrop\s+(table|column|function|policy)\b/i.test(code), 'no drop');
  assert.ok(!/\btruncate\b/i.test(code) && !/\bdelete\s+from\b/i.test(code));
  assert.ok(!/\bupdate\s+public\.(quotes|quote_versions|event_tasks|run_sheet_items|event_day_plans)\b/i.test(code), 'no existing row changed');
  assert.ok(!/[^\x00-\x7F]/.test(SQL) && !/[^\x00-\x7F]/.test(APPLY), 'ASCII only (Supabase paste)');
  assert.ok(!/create\s+temp/i.test(APPLY) && !/^\\/m.test(APPLY), 'no temp tables / psql commands in the paste');
  for (const tg of ['_r397_tg_versions', '_r397_tg_quote', '_r397_tg_tasks', '_r397_tg_runsheet', '_r397_tg_dayplan']) {
    const i = SQL.indexOf('function public.' + tg + '()'), body = SQL.slice(i, SQL.indexOf('$fn$;', i));
    assert.ok(i > 0 && !/insert into|update public|delete from/i.test(body), tg + ' only refuses');
  }
  assert.match(SQL, /if not exists \(select 1 from pg_trigger where tgname = 'zz_r397_plan_lock' and tgrelid = 'public\.quote_versions'::regclass\)/, 'idempotent');
});
await t('4b the unlock needs Quotes edit + a reason; lock after confirmation; signed-in requests only; the test switch is documented', () => {
  assert.match(SQL, /if not coalesce\(public\.has_area\('quotes', 'edit'\), false\) then raise exception 'not allowed' using errcode = '42501'; end if;\n    if v_reason is null or char_length\(v_reason\) < 3 then raise exception 'reason_required/);
  assert.match(SQL, /if coalesce\(v_status, ''\) <> 'confirmed' then raise exception 'not_confirmed/);
  assert.match(SQL, /select coalesce\(current_setting\('helm\.r397_plan_lock', true\), ''\) <> 'off' and auth\.uid\(\) is not null;/);
  assert.match(RUNALL, /-c helm\.r397_plan_lock=off -c /); assert.match(DBT, /select set_config\('helm\.r397_plan_lock', 'on', false\);/);
  assert.match(RUNALL, /run "r227-plan-lock-0397" "R227-PLAN-LOCK-0397: ALL PASS \\\(36\/36\\\)" psql -q -f tests\/db\/r227-plan-lock-0397\.sql/);
});
await t('4c APPLY-0397: one transaction, the migration body, 12 check rows; MANIFEST lists 0397', () => {
  assert.match(APPLY, /^-- APPLY-0397/); assert.match(APPLY, /\nbegin;\n/); assert.match(APPLY, /\ncommit;\n$/);
  assert.ok(APPLY.includes(SQL.trim().split('\n').slice(-3).join('\n')), 'the whole migration is in the paste');
  assert.equal((APPLY.match(/^  \('\d\d /gm) || []).length, 12);
  assert.match(MAN, /\nforward  supabase\/migrations\/0397_r227_event_plan_lock\.sql\n/);
  assert.ok(existsSync(new URL('../tests/db/r227-plan-lock-0397.sql', import.meta.url)));
});

console.log(`\nR227 event-day planner + plan lock: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
