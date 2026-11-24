// r252-workflow-sync.test.mjs - R252 (owner, 24 Nov 2026: "everything should be syncing to the workflow of the quotation").
// The event pages Logistics, Resource plan, Run-sheet, Event-day command, Teardown, Settlement, Closure:
//   1  event-flow-line.js: the stage in words, the Day-before link by permission, "read again when you come back"
//   2  command: check-in times + booking on the arrival rows; vendor "Left" -> one press also marks the booking on Teardown
//   3  teardown / logistics / resources: controls only where the DATABASE saves (Vendors / Event plan), a refused read is not "empty"
//   4  guest count: declined groups not counted, said when it differs from the quote
//   5  order Teardown -> Settlement -> Closure, vendors with no cost, what closing leaves open
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('  ok ' + name); };
const FL = read('public/event-flow-line.js'), CSS = read('public/event-flow-line.css');
const PAGES = Object.fromEntries(['logistics', 'resources', 'runsheet', 'command', 'teardown', 'settlement', 'closure'].map((p) => [p, read('public/' + p + '.html')]));

function world(o = {}) {
  const on = {}, mk = (tag) => ({ tag, children: [], text: '', attrs: {}, get firstChild() { return this.children[0] || null; }, appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); }, set textContent(v) { this.text = v; }, get textContent() { return this.text + this.children.map((c) => c.textContent).join(''); } });
  const doc = { hidden: false, body: {}, activeElement: null, createElement: mk, createTextNode: (s) => ({ textContent: s }), addEventListener: (k, f) => { on[k] = f; }, querySelectorAll: () => o.dialogs || [] };
  const win = { document: doc, addEventListener: (k, f) => { on[k] = f; }, encodeURIComponent, Promise, Date: o.Date || Date, module: undefined,
    BPStore: { quoteStatus: (q) => ({ confirmed: q.approvalStatus === 'approved' || q.approvalStatus === 'paid' }), auth: { canView: async (a) => (o.view || {})[a] } } };
  win.window = win; vm.createContext(win); vm.runInContext(FL, win); return { F: win.HelmFlowLine, doc, on, mk };
}
const hrefOf = (host) => (host.children.find((c) => c.tag === 'a') || {}).href;

await t('stage words: workspace names, a client-approved quote reads Confirmed, cancelled / closed win', () => {
  const { F } = world(), s = (q) => F.stage(q);
  assert.equal(s({ lifecycleStage: 'event_day' }), 'Event Day'); assert.equal(s({ lifecycleStage: 'quote' }), 'Quote'); assert.equal(s({}), 'Quote');
  assert.equal(s({ lifecycleStage: 'quote', approvalStatus: 'approved' }), 'Confirmed'); assert.equal(s({ lifecycleStage: 'planning', approvalStatus: 'approved' }), 'Planning');
  assert.equal(s({ lifecycleStage: 'event_day', status: 'cancelled' }), 'Cancelled'); assert.equal(s({ lifecycleStage: 'settlement', closedAt: 'x' }), 'Closed'); assert.equal(s(null), '');
  const EV = read('public/event.html');   // the same words as the workspace strip
  for (const m of EV.slice(EV.indexOf('const STAGES=['), EV.indexOf('const stageIndex')).matchAll(/\{k:"(\w+)",label:"([^"]+)"/g)) assert.equal(s({ lifecycleStage: m[1] }), m[2], m[1]);
});
await t('Day-before link: Event Ready (Ready + Staff), else Tasks & Crew, else Event Ready, else nothing; unknown = no', async () => {
  const go = async (view, ev = { id: 'q 1', lifecycleStage: 'ready' }) => { const w = world({ view }), h = w.mk('span'); await w.F.mount(h, ev, { dayBefore: true }); return hrefOf(h); };
  assert.equal(await go({ ready: true, staff: true }), 'ready.html?quote=q%201#rdDay'); assert.equal(await go({ staff: true }), 'ops.html?quote=q%201');
  assert.equal(await go({ ready: true }), 'ready.html?quote=q%201'); assert.equal(await go({}), undefined); assert.equal(await go({ ready: 'yes', staff: undefined }), undefined);
  assert.equal(await go({ ready: true, staff: true }, { id: 'q1', status: 'cancelled' }), undefined, 'a cancelled event is not checked');
  assert.match(read('public/ready.html'), /id="rdDay"/);
});
await t('onReturn: only when visible, not while busy, at most every 15 s; the Back button reads at once', async () => {
  let now = 1000; class D extends Date { static now() { return now; } }
  const w = world({ Date: D }); let c = 0, busy = false; w.F.onReturn(() => { c++; }, () => busy);
  const tick = async () => { w.on.visibilitychange(); await new Promise((r) => setTimeout(r, 0)); };
  await tick(); assert.equal(c, 0, 'just opened'); now += 20000; w.doc.hidden = true; await tick(); assert.equal(c, 0); w.doc.hidden = false; busy = true; await tick(); assert.equal(c, 0);
  busy = false; await tick(); assert.equal(c, 1); await tick(); assert.equal(c, 1); w.on.pageshow({ persisted: false }); await new Promise((r) => setTimeout(r, 0)); assert.equal(c, 1);
  w.on.pageshow({ persisted: true }); await new Promise((r) => setTimeout(r, 0)); assert.equal(c, 2);
});
await t('inUse: an open dialog, a focused box, an unsaved value', () => {
  const vis = { hidden: false, getClientRects: () => [1] }, box = (v, d) => ({ type: 'text', value: v, defaultValue: d, getClientRects: () => [1] });
  let w = world({ dialogs: [vis] }); assert.equal(w.F.inUse(null), true); w = world({ dialogs: [{ hidden: true, getClientRects: () => [] }] }); assert.equal(w.F.inUse(null), false);
  const root = (...b) => ({ querySelectorAll: () => b }); assert.equal(w.F.inUse(root(box('', ''), box('0', '0'))), false); assert.equal(w.F.inUse(root(box('Ravi', ''))), true);
  assert.equal(w.F.inUse(root({ type: 'checkbox', value: 'on', defaultValue: '' })), false); w.doc.activeElement = { tagName: 'SELECT' }; assert.equal(w.F.inUse(null), true);
});
await t('every page has the stage line, the shared files and reads again on return; the file itself never writes', () => {
  for (const [p, h] of Object.entries(PAGES)) {
    assert.match(h, /<script src="\/event-flow-line\.js\?v=\d+"><\/script>/, p); assert.match(h, /<link rel="stylesheet" href="\/event-flow-line\.css\?v=\d+">/, p);
    assert.match(h, /<span id="flowLine"><\/span>/, p); assert.match(h, /HelmFlowLine\.mount\(\$\("#flowLine"\),ev,\{id/, p); assert.match(h, /HelmFlowLine\.onReturn\(/, p);
  }
  for (const p of ['logistics', 'resources', 'runsheet']) assert.match(PAGES[p], /mount\(\$\("#flowLine"\),ev,\{id,dayBefore:true\}\)/, p);
  assert.doesNotMatch(FL, /innerHTML|insertAdjacentHTML|\.(update|add|remove|insert|rpc|setStatus)\(/); assert.doesNotMatch(CSS, /#[0-9a-f]{3,8}\b(?!\w)/i, 'theme tokens only');
  // coming back never writes: no pull of the team list, no release of stock
  const C = PAGES.command, back = C.slice(C.indexOf('HelmFlowLine.onReturn(')); assert.doesNotMatch(back, /pullRoster|pullFromLogistics/);
  const T = PAGES.teardown; assert.match(T, /onReturn\(async\(\)=>\{ noRelease=true; try\{/); assert.match(T, /if\(canEdit && !noRelease && eventDayCome\(\)/);
  assert.match(PAGES.logistics, /onReturn\(\(\)=>tab==="payments"\?null:renderPane\(\)/);
});

// ---- command: the two records of one person / vendor ----
function cmd(o = {}) {
  const C = PAGES.command, src = C.slice(C.indexOf('  const T12='), C.indexOf('  async function alsoExit')) + C.slice(C.indexOf('  async function alsoExit'), C.indexOf('  async function renderArrivals'));
  const said = [], wr = [], ctx = { times: o.times || null, bks: o.bks || null, id: 'q1', canSeeVend: true, BPUI: { toast: (m, x) => said.push([m, x.type]) },
    BPStore: { bookings: { list: async () => JSON.parse(JSON.stringify(o.rows || [])), update: async (i, p) => { wr.push([i, p]); if (!o.silent) Object.assign(o.rows.find((b) => b.id === i), p); return true; } } } };
  vm.createContext(ctx); vm.runInContext(src + ';this.arrNote=arrNote;this.alsoExit=alsoExit;this.checkInOf=checkInOf;this.T12=T12;', ctx); return { ctx, said, wr };
}
await t('command: arrival rows say the check-in times; arrived with no time says so; unreadable = nothing is said', () => {
  const times = { c1: { entries: [{ day: '2026-11-28', in: '09:00', out: '10:00' }, { day: '2026-11-29', in: '17:42', out: '' }] }, c2: { entries: [], flag: null }, c3: { entries: [], flag: 'no_show_suspected', expected_start: '16:00' } };
  const { ctx } = cmd({ times }), note = (a) => (ctx.arrNote(a) || {}).t;
  assert.equal(note({ ref_id: 'c1', status: 'arrived' }), 'Checked in 5:42 PM'); assert.match(note({ ref_id: 'c2', status: 'arrived' }), /^No check-in time/); assert.equal(note({ ref_id: 'c2', status: 'expected' }), undefined);
  assert.equal(note({ ref_id: 'c3', status: 'expected' }), 'Not checked in - expected 4:00 PM'); assert.equal(note({ ref_id: 'zz', status: 'arrived' }), undefined); assert.equal(note({ status: 'arrived' }), undefined);
  assert.equal(cmd().ctx.arrNote({ ref_id: 'c2', status: 'arrived' }), null); assert.equal(ctx.T12('00:05'), '12:05 AM'); assert.equal(ctx.T12('12:30'), '12:30 PM');
  assert.match(PAGES.command, /Already checked in/); assert.match(PAGES.command, /MutationObserver\(\(\)=>\{[^\n]*renderArrivals[^\n]*observe\(\$\("#crewTimesheet"\),\{childList:true\}\)/);
});
await t('command: vendor Left -> "Also mark exited on Teardown" only for a live booking; one press, checked before and after', async () => {
  const bks = Object.fromEntries([['b1', 'confirmed'], ['b2', 'delivered'], ['b3', 'cancelled'], ['b4', 'enquiry'], ['b5', 'booked']].map(([id, status]) => [id, { id, status }])), { ctx } = cmd({ bks });
  const ex = (r, s) => { const x = ctx.arrNote({ ref_id: r, status: s }); return x && x.exit; };
  assert.equal(ex('b1', 'left'), 'b1'); assert.equal(ex('b5', 'left'), 'b5'); for (const [r, s] of [['b1', 'arrived'], ['b1', 'expected'], ['b2', 'left'], ['b3', 'left'], ['b4', 'left']]) assert.ok(!ex(r, s), r + s);
  assert.match(ctx.arrNote({ ref_id: 'b2', status: 'arrived' }).t, /Teardown/); assert.match(ctx.arrNote({ ref_id: 'b3', status: 'expected' }).t, /cancelled/);
  let w = cmd({ rows: [{ id: 'b1', status: 'confirmed' }] }); await w.ctx.alsoExit('b1'); assert.deepEqual(JSON.parse(JSON.stringify(w.wr)), [['b1', { status: 'delivered' }]]); assert.equal(w.said[0][1], 'ok');
  w = cmd({ rows: [{ id: 'b1', status: 'confirmed' }], silent: true }); await w.ctx.alsoExit('b1'); assert.equal(w.said[0][1], 'err', 'a refused save is never "done"');
  for (const s of ['cancelled', 'enquiry', 'delivered']) { w = cmd({ rows: [{ id: 'b1', status: s }] }); await w.ctx.alsoExit('b1'); assert.equal(w.wr.length, 0, s + ' is never overwritten'); }
  const C = PAGES.command; assert.match(C, /if\(!n\.exit\|\|!canVend\|\|!acts\) return;/); assert.match(C, /canVend=canVend&&canSeeVend&&canEdit;/);
  assert.match(C, /m\[b\.id\]=\{id:b\.id,status:b\.status\}/, 'no money column is kept'); assert.match(C, /canSeeIss\?`<a class="mini" href="issues\.html\?quote=/);
  assert.match(read('public/event-steps.js'), /b\.status === "delivered" \|\| at\[b\.id\] === "left"/, 'Wrap-up counts either record');
});

// ---- pages whose own area is not the area of the table they save to ----
await t('the database areas these rules follow (0057 policies): vendors / plan / command', () => {
  const S = read('supabase/phase57-multitenant-rls.sql');
  assert.match(S, /"vendors":\["vendors","event_resources","event_resource_needs"\]/); assert.match(S, /"plan":\["event_plan","event_checklist"/); assert.match(S, /"command":\["event_day"/);
});
await t('teardown: vendor exit needs Vendors, the list needs Event plan; hidden lists are not called empty; exit is read back', () => {
  const T = PAGES.teardown;
  assert.match(T, /seeBk=r\[0\]; canExit=canEdit&&r\[0\]&&r\[1\]; seeTd=r\[2\]; canTd=canEdit&&r\[2\]&&r\[3\]; seeArr=r\[4\];/); assert.match(T, /canView\("vendors"\)\), may\(\(\)=>A\.canEditArea\("vendors"\)\), may\(\(\)=>A\.canView\("plan"\)\), may\(\(\)=>A\.canEditArea\("plan"\)\), may\(\(\)=>A\.canView\("command"\)/);
  assert.match(T, /\$\{canExit&&\(b\.status==="booked"\|\|b\.status==="confirmed"\)\?/); assert.match(T, /\$\{canTd\?`<select class="ssel" data-td=/); assert.match(T, /\$\("#tdAdd"\)\.hidden=!canTd;/); assert.match(T, /Your role can\\'t see vendors/); assert.match(T, /Your role can\\'t see the teardown list/);
  const ex = T.slice(T.indexOf('[data-exit]'), T.indexOf('async function renderTeardown')); assert.ok(ex.indexOf('now.status!=="booked"') < ex.indexOf('bookings.update(') && ex.indexOf('bookings.update(') < ex.indexOf('after.status!=="delivered"'));
});
await t('logistics: lists need Event plan, tabs open by #name, a template that adds nothing says why', () => {
  const L = PAGES.logistics;
  assert.match(L, /seeList=r\[0\]; editList=canEdit&&r\[0\]&&r\[1\];/); assert.match(L, /if\(!seeList\)\{ \$\("#pane"\)\.innerHTML=/); assert.doesNotMatch(L, /\$\{canEdit\?`<select class="ssel" data-st=/);
  assert.match(L, /\^#\(compliance\|comms\|logistics\|guests\)\$/); assert.match(L, /everything in that template is already on the list/); assert.match(L, /if\(tab==="payments"\) return renderPayments\(\);\n\s+if\(!seeList\)/, 'payments keep their own rule');
});
await t('logistics: declined groups are not counted and the quote guest count is compared (same rule as Day before)', () => {
  const L = PAGES.logistics, src = L.slice(L.indexOf('    const total = items.reduce((a,g)'), L.indexOf('    $("#pane").innerHTML = `<h2>Guest count'));
  const run = (items, guests) => { const c = { items, ev: { client: { guests } } }; vm.createContext(c); vm.runInContext(src.replace(/const /g, 'var '), c); return c; };
  const g = [{ qty: 200, status: 'done' }, { qty: 80, status: 'na' }, { qty: 50, status: 'open' }];
  assert.equal(run(g, 300).total, 250); assert.equal(run(g, 300).gone, 1); assert.match(run(g, 300).qNote, /quote is for 300 guests, these groups add up to 250/); assert.equal(run(g, 250).qNote, ''); assert.equal(run(g, 0).qNote, ''); assert.equal(run([], 300).qNote, '');
  assert.match(read('public/day-before.js'), /c\.status === "na" \? 0 : n0\(c\.qty\)/);
});
await t('resource plan: short vendor quantities are missing, not covered; no guess without numbers; needs Vendors', () => {
  const R = PAGES.resources, src = R.slice(R.indexOf('  function shortOf(c)'), R.indexOf('  function rpStatusPill'));
  const sh = (bookings, c) => { const x = { bookings }; vm.createContext(x); vm.runInContext(src + ';this.f=shortOf;', x); return x.f(c); };
  const c = { id: 'n1', qty: 50, have: 5 };
  assert.equal(sh([{ need_id: 'n1', qty: 30, status: 'confirmed' }], c), 15); assert.equal(sh([{ need_id: 'n1', qty: 30, status: 'confirmed' }, { need_id: 'n1', qty: 20, status: 'enquiry' }], c), 0);
  assert.equal(sh([{ need_id: 'n1', qty: 30, status: 'confirmed' }, { need_id: 'n1', qty: 20, status: 'cancelled' }], c), 15); assert.equal(sh([{ need_id: 'n1', qty: null, status: 'booked' }], c), 0); assert.equal(sh([], c), 0);
  assert.match(R, /cov=checked\.filter\(c=>c\.covered&&!isShort\(c\)\)/); assert.match(R, /if\(!cv \|\| !sv\)\{ canEdit=false; canDelete=false; canInv=false; canStaff=false; \}/); assert.match(R, /No cost yet/); assert.match(R, /if\(!seeVend\)\{ \$\("#rows"\)/);
});
await t('order: Teardown -> Settlement -> Closure in the links (nothing is blocked)', () => {
  assert.match(PAGES.teardown, /\(set\?"settlement\.html":"closure\.html"\)\+q/); assert.match(PAGES.settlement, /Before this: Teardown<\/a>/); assert.match(PAGES.settlement, /id="nextLink" href="#">Next: Closure →<\/a>/);
  assert.doesNotMatch(PAGES.settlement, /Next: Teardown/); assert.match(PAGES.settlement, /No cost yet - counts as 0\./); assert.match(PAGES.settlement, /Only asked - not booked\./);
});
await t('closure: what the close rules do not ask about is listed, in words, with links by permission; never blocks', () => {
  const C = PAGES.closure, src = C.slice(C.indexOf('  function leftoverParts('), C.indexOf('  async function renderLeftovers'));
  const x = { id: 'q1', encodeURIComponent }; vm.createContext(x); vm.runInContext(src + ';this.f=leftoverParts;', x);
  const p = JSON.parse(JSON.stringify(x.f({ tasks_open: 2, issues_open: 1 }, { staff: true, teardown: 1, notLeft: 1, noCost: 2, inventory: true })));
  assert.deepEqual(p, [['2 tasks not finished', 'ops.html?quote=q1'], ['1 issue open', ''], ['1 teardown item open', 'teardown.html?quote=q1'], ['1 vendor not marked as left', 'teardown.html?quote=q1'], ['2 vendors with no cost or bill (count as 0)', '']]);
  assert.deepEqual(JSON.parse(JSON.stringify(x.f({}, {}))), []); const r = C.slice(C.indexOf('async function renderLeftovers'), C.indexOf('// r20 planner: with blockers')); assert.doesNotMatch(r, /innerHTML|closeBtn|fmtMoney|inr\(/); assert.match(r, /if\(closedAt \|\| !review/);
});
console.log('r252-workflow-sync: ' + n + ' ok');
