// r255-d (owner, 25 Nov 2026): the event workspace says what a blocked stage needs and how to do it; one strip with the four steps of
// covering an event on all four pages; the floor plan's products are matched to stock and reserved in one tap; a Client login or a
// switched-off one can't be put in the event group; Monitor is one tap away; the wall screen has a clear way out; today's event first.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const req = createRequire(import.meta.url);
let n = 0; const t = async (name, f) => { try { await f(); n++; console.log('  ok ' + name); } catch (e) { console.error('FAIL - ' + name); throw e; } };
const EV = read('public/event.html'), INV = read('public/inventory.html'), LJS = read('public/inventory-layout.js'), MON = read('public/monitor.js'), MHTML = read('public/monitor.html'), MCSS = read('public/monitor.css');
const L = req('../public/inventory-layout.js'), RS = req('../public/resource-steps.js'), SN = req('../public/stage-needs.js');

/* ---- 1 the stage panel ---- */
const cut = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); assert.ok(i > 0 && j > i, a); return src.slice(i, j); };
function needs(gate, o = {}) {
  const el = (tag, p) => ({ tag, text: p.text, href: p.href || '', onclick: p.onclick });
  const ctx = { id: 'q 1', window: { HelmStageNeeds: SN }, HelmStageNeeds: SN, encodeURIComponent, Array, String, el, ev: { code: 'EV-1', eventDate: '2026-11-26', client: {} }, planSummary: { package: 'Gold', menu_locked: false }, menuCount: 0, staleInfo: null, canEditPlan: true,
    menuIsChosen: () => !!(ctx.planSummary && ctx.planSummary.package) || ctx.menuCount > 0, niceDay: (d) => d, lockMenuFromCard: () => { ctx.locked = 1; }, clearStageInfo() {}, render() {}, focusDate() {}, $: () => null, ...o };
  vm.createContext(ctx);
  vm.runInContext(cut(EV, '  function stageNeeds(g,label){', '  // nothing stops the move') + '\nthis.f=stageNeeds;', ctx);
  return { ctx, list: Array.from(ctx.f(gate, 'Planning')).map((x) => ({ text: x.text, act: x.act ? x.act() : null })) };
}
await t('Planning: each missing thing has its own button; locking is right there', () => {
  const P = (nd) => ({ gate: 'planning', needs: nd, message: 'Planning needs: ' + nd.join(', ') });
  let r = needs(P(['menu locked', 'layout v1']));
  assert.deepEqual(r.list.map((x) => [x.text, x.act.text]), [['The menu is not locked yet (Gold is chosen).', '🔒 Lock the menu'], ['No floor plan with items on it is saved yet.', 'Draw the floor plan']]);
  assert.equal(r.list[1].act.href, 'builder.html?quote=q%201');
  r.list[0].act.onclick({ detail: 1, currentTarget: {} }); assert.equal(r.ctx.locked, 1);
  const twice = needs(P(['menu locked'])); twice.list[0].act.onclick({ detail: 2 }); assert.equal(twice.ctx.locked, undefined, 'the 2nd click of a double-click does nothing');
  assert.deepEqual([needs(P(['menu locked']), { planSummary: null }).list[0].act.text], ['Choose the menu']);
  assert.equal(needs(P(['menu locked']), { canEditPlan: false }).list[0].act.text, 'Open Venue & menu');
  assert.match(needs(P(['menu locked']), { staleInfo: {} }).list[0].text, /until the client approves the new price/);
  assert.equal(needs(P(['menu locked']), { planSummary: { package: 'Gold', menu_locked: true } }).list[0].act.text, 'Check again');
  assert.deepEqual(needs({ gate: 'planning', message: 'Planning needs: menu locked, layout v1' }).list.length, 2, 'older answer without the needs list');
});
await t('the other gates in plain words', () => {
  assert.equal(needs({ gate: 'confirmed', message: 'x' }).list[0].act.href, 'quotes.html?focus=EV-1');
  assert.deepEqual(needs({ gate: 'event_day', message: 'x' }).list.map((x) => [x.text, x.act]), [['Planning opens on 2026-11-26, the event date. Nothing to do before then.', null]]);
  assert.equal(needs({ gate: 'event_day', message: 'x' }, { ev: { code: 'E', eventDate: '', client: {} } }).list[0].act.text, 'Set the event date');
  assert.equal(needs({ gate: 'closed', hard: true, message: 'closed' }).list.length, 0);
});
await t('locking refreshes the panel; the override is a small link after the real way; the menu pill says what it means', () => {
  assert.match(EV, /BPUI\.toast\("Menu locked\.",\{type:"ok"\}\);\s*clearStageInfo\(\);/);
  assert.match(EV, /class:"sp-link",text:"Override as admin…"/); assert.doesNotMatch(EV, /class:"btn sm ghost",text:"Override as admin…"/);
  assert.match(EV, /<span class="stat q">Menu not locked<\/span>/); assert.match(EV, /The stage does not change by itself/);
});
await t('Event Ready: a refused move shows the same list with buttons; other errors stay errors; the resource plan card says its steps', () => {
  const b = [{ gate: 'planning', needs: ['layout v1'], message: 'Planning needs: layout v1' }];
  assert.deepEqual(SN.fromError({ code: 'HL409', details: JSON.stringify(b) }), b); assert.equal(SN.fromError({ code: '42501', message: 'not authorized' }), null); assert.equal(SN.fromError(null), null);
  assert.deepEqual(SN.fromError({ code: 'HL409', message: "Can't move to Ready yet - no plan.", details: '' }), [{ gate: 'other', message: 'no plan.' }]);
  assert.match(SN.list({ gate: 'confirmed', stale: true }, { code: 'E' })[0].text, /must approve again/);
  const R = read('public/ready.html'); assert.match(R, /HelmStageNeeds\.fromError\(e\)/); assert.match(R, /BPStore\.plan\.setLock\(id,true\)/); assert.match(R, /id="rdNeed" role="status"/); assert.match(R, /\/stage-needs\.js\?v=\d+/);
  assert.match(EV, /"Reserve our stock, get the rest from vendors, then assign our people\."/); assert.match(EV, /\/stage-needs\.js\?v=\d+/);
});
/* ---- 2 + 3 the four steps ---- */
await t('four steps: links keep the event, steps you may not open are left out, Next goes on', () => {
  assert.deepEqual(RS.STEPS.map((s) => s.label), ['Reserve our stock', "Get what's missing from vendors", 'Assign our people', 'Check budget & margin']);
  assert.deepEqual(RS.STEPS.map((s) => RS.href(s.key, 'q 1')), ['inventory.html?quote=q%201', 'resources.html?quote=q%201', 'ops.html?quote=q%201', 'budget.html?quote=q%201']);
  assert.equal(RS.next('vendors').key, 'people'); assert.equal(RS.next('budget'), null); assert.equal(RS.next('people', { finance: false }), null);
  assert.equal(RS.firstOpen({}, 'q'), 'inventory.html?quote=q'); assert.equal(RS.firstOpen({ inventory: false }, 'q'), 'resources.html?quote=q'); assert.equal(RS.firstOpen({ inventory: false, staff: false, resources: false, finance: false }, 'q'), '');
  assert.equal(RS.href('stock', ''), '');
  for (const [f, k] of [['inventory', 'stock'], ['ops', 'people'], ['resources', 'vendors'], ['budget', 'budget']]) { const h = read('public/' + f + '.html');
    assert.match(h, new RegExp('<nav class="rs"[^>]*data-resource-steps="' + k + '"')); assert.match(h, /\/resource-steps\.js\?v=\d+/); assert.match(h, /\/resource-steps\.css\?v=\d+/); }
  assert.match(EV, /href:resourcePlanHref\(\)/);
  assert.doesNotMatch(read('public/resource-steps.js'), /innerHTML|insertAdjacentHTML|\.style\./);
  assert.match(read('public/resource-steps.css'), /\.rs-list\{[^}]*overflow-x:auto/);
});
/* ---- 4 stock suggestions ---- */
const I = (id, name, x) => ({ id, name, active: true, total_qty: 3, ...x });
const fit = (type, names) => { const f = L.findFits({ layout_type: type, label: '' }, names.map((x, i) => I('i' + i, x)), [], null); return [f.hit ? f.hit.name : null, f.list.length]; };
await t('matching: plurals, case, sizes, slashes and everyday names; never a different thing; several = the person picks', () => {
  for (const [ty, nm] of [['dj', 'dj  BOOTHS'], ['dj', 'DJ console'], ['canopy', '10x10 canopy'], ['dessert', 'Candy tables'], ['chandelier', 'Chandelier (crystal)'], ['drape', 'Pipe and Drapes'], ['generator', 'Genset'], ['sofa', 'Sofa 3-seater white'], ['jyothi', 'Jyoti Prajwalan'], ['videowall', 'LED wall'], ['speaker', 'PA speakers'], ['stage', 'Stage']])
    assert.equal(fit(ty, [nm])[0], nm, ty + ' ~ ' + nm);
  for (const [ty, nm] of [['bar', 'Bar stool'], ['fountain', 'Chocolate fountain'], ['booth', 'Photo booth'], ['monitor', 'LED monitor 24in'], ['stage', 'Stage light'], ['seatblock', 'Chair cover'], ['arch', 'Floral arch'], ['exit', 'Exit zone'], ['sofa', 'Couple sofa']])
    assert.equal(fit(ty, [nm])[0], null, ty + ' is not ' + nm);
  assert.deepEqual(fit('floralarch', ['Floral arch small', 'Floral arch large']), [null, 2]);
});
await t('two products share what is free; nothing is offered while the number is not known; other linked products come first', () => {
  const f = (m) => (id) => (id in m ? m[id] : null);
  assert.deepEqual(L.planTake([{ item_id: 'a', want: 2 }, { item_id: 'a', want: 2 }], f({ a: 3 })), [{ free: 3, take: 2, short: 0 }, { free: 1, take: 1, short: 1 }]);
  assert.deepEqual(L.planTake([{ item_id: 'a', want: 1 }], f({})), [{ free: null, take: 0, short: 0 }]);
  assert.deepEqual(L.planTake([{ item_id: 'a', want: 1 }], f({ a: 2 }), { a: 2 }), [{ free: 0, take: 0, short: 1 }]);
  assert.deepEqual(L.planTake([{ item_id: 'a', want: 1 }], f({ a: -4 })), [{ free: 0, take: 0, short: 1 }]);
});
await t('a table whose chairs are linked is still listed until the table is', () => {
  const b = (links) => ({ types: [{ layout_type: 'table', objects: 10, seats: 80, links }] });
  assert.equal(L.tableGaps(b([{ count_mode: 'seats' }])).length, 1); assert.equal(L.tableGaps(b([])).length, 0); assert.equal(L.tableGaps(b([{ count_mode: 'seats' }, { count_mode: 'objects' }])).length, 0);
});
await t('link + reserve: link first, the server says what is still to reserve, the atomic reserve; undo only releases', () => {
  const s = cut(LJS, '  function linkAndReserve(block, q) {', '  function doneText(d) {');
  const at = (x) => { const i = s.indexOf(x); assert.ok(i >= 0, x); return i; };
  assert.ok(at('B.layout.setLink(') < at('B.layout.needs(') && at('B.layout.needs(') < at('B.reserve('));
  assert.match(s, /Math\.min\(q\.want, Math\.ceil\(r\.toReserve\), Math\.floor\(r\.free\)\)/); assert.doesNotMatch(s, /allowOver/);
  const u = cut(LJS, '  function lastNote() {', '  // a product of the plan with no stock item: its numbers');
  assert.match(u, /setResStatus\(x\.id, "cancelled"\)/); assert.doesNotMatch(u, /removeRes/); assert.match(u, /x\.status === "reserved"/);
  assert.match(LJS, /if \(S\.qbusy\) return; S\.qbusy = true;/); assert.match(INV, /freeFor:\(i\)=>/);
  for (const w of ["We don't have this in stock.", 'Get from a vendor', 'Choose a stock item', 'Reserve all suggested (', 'The names do not have to be the same']) assert.ok(LJS.includes(w), w);
});
/* ---- 5 event group ---- */
await t('event group: a Client login and a switched-off one stay listed, can not be ticked or sent; the header stays above the pictures', () => {
  const win = {}; vm.runInNewContext(read('public/event-group-picker.js'), { window: win, document: { addEventListener() {} }, BPStore: {}, Set, Array, Object, String, Promise, RegExp });
  const w = win.HelmEventGroupPicker.offWhy;
  assert.equal(w({ role: 'client', full_name: 'client' }), "Clients can't join the team group"); assert.equal(w({ role: 'event_manager', full_name: 'Pat (deactivated)' }), 'Sign-in is switched off');
  assert.equal(w({ role: 'crew', full_name: 'crew' }), ''); assert.equal(w({ role: 'crew', full_name: 'Asha', active: false }), 'Sign-in is switched off');
  const JS = read('public/event-group-picker.js'), CSS = read('public/event-group-picker.css');
  assert.match(JS, /if \(seen\[i\.value\] \|\| i\.disabled \|\| offs\[i\.value\]\) return;/); assert.match(JS, /if \(r\.off\) i\.disabled = true;/);
  assert.match(CSS, /\.egp-sec\{position:sticky;top:0;z-index:2;/);
  assert.match(read('supabase/migrations/0299_r58_crew_events_hardening.sql'), /coalesce\(p\.role, ''\) <> 'client'/);   // the server's own rule
});
/* ---- 6 monitor button ---- */
await t('Monitor button: confirmed to event day only, not cancelled / settlement / closed', () => {
  assert.match(EV, /id="monBtn"[^>]*hidden>Monitor →<\/a>/);
  assert.match(EV, /const showMonitor=\(\)=> !!ev && !evLocked\(\) && !cardDenied\.has\("tasks"\) && isConfirmed\(\) && stageIndex\(effStage\(\)\)<=stageIndex\("event_day"\);/);
});
/* ---- 7 + 8 monitor ---- */
const win = {};
vm.runInNewContext(read('public/task-status.js'), { window: win, Intl, Date, Math, Number, String, Object, Array, JSON, isFinite, isNaN, Infinity, Promise, setInterval() {}, clearInterval() {} });
vm.runInNewContext(MON, { sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} }, BPStore: { studioTimezone: () => 'Asia/Kolkata' }, window: win, document: { getElementById: () => null, readyState: 'complete', addEventListener() {} }, Intl, Date, Math, Number, String, Object, Array, JSON, isFinite, isNaN, Infinity, Promise, setInterval() {}, clearInterval() {}, localStorage: { getItem() { return null; }, setItem() {} }, URLSearchParams, URL, location: { search: '', pathname: '/' } });
const M = win.HelmMonitor, e = (id, d) => ({ quote_id: id, event_date: d, is_today: d === '2026-11-25' }), ids = (l) => l.map((x) => x.quote_id).join();
await t('monitor: today first, then tomorrow, then what is over; before 6 am the night that is running', () => {
  const list = [e('y', '2026-11-24'), e('tm', '2026-11-26'), e('t', '2026-11-25'), e('old', '2026-11-20'), e('x', '')];
  assert.equal(ids(M._orderEvents(list, '2026-11-25', 7)), 't,tm,y,old,x'); assert.equal(ids(M._orderEvents(list, '2026-11-25', 2)), 'y,t,tm,old,x');
  assert.equal(M._firstEvent(list, 'y', '2026-11-25', 7), 't', "yesterday's event is not remembered over today's"); assert.equal(M._firstEvent([e('y', '2026-11-24'), e('tm', '2026-11-26')], 'y', '2026-11-25', 7), 'tm');
  const two = [e('t', '2026-11-25'), e('t2', '2026-11-25')]; assert.equal(M._firstEvent(two, 't2', '2026-11-25', 9), 't2'); assert.equal(M._firstEvent(two, 'all', '2026-11-25', 9), 'all'); assert.equal(M._firstEvent([e('t', '2026-11-25')], 'all', '2026-11-25', 9), 't');
  assert.equal(M._firstEvent([], 'a', '2026-11-25', 9), ''); assert.equal(M._firstEvent([e('y', '2026-11-24')], null, '2026-11-25', 9), 'y');
});
await t('wall screen: a clear way out, Esc, normal size by default, no A- / A+ (R258, the saved size is forgotten)', () => {
  assert.match(MHTML, /id="monWallX"/); assert.match(MHTML, /id="monWallBack"[^>]*>Back to event/); assert.match(MHTML, /id="monBack"/); assert.doesNotMatch(MHTML + MON + MCSS, /data-size-step|data-mon-size|mon-sizes/); assert.match(MHTML, /id="monWall"/);
  assert.match(MON, /localStorage\.removeItem\(LS_SIZE\)/); assert.doesNotMatch(MON, /setItem\(LS_SIZE/); assert.match(MON, /fullscreenchange/); assert.match(MON, /localStorage\.removeItem\(LS_WALL\)/); assert.doesNotMatch(MON, /localStorage\.setItem\(LS_WALL/);
  assert.match(MCSS, /\.mon-wallbar\{position:sticky;top:var\(--hb-top,0px\)/); assert.equal((MCSS.match(/\{/g) || []).length, (MCSS.match(/\}/g) || []).length);
});
await t('monitor rows carry the "Same time as" tag of Tasks & Crew', () => {
  assert.match(MON, /TC\.board\(\{ quoteId: S\.quote, tasks: S\.tasks/); assert.match(MON, /"mon-chip is-same"/); assert.doesNotMatch(MON, /innerHTML/);
});
console.log('\nr255-d: ' + n + ' passed');
