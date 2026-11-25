// R256 (owner, 25 Nov 2026: "Remove that unlock and lock from the 2D 3D layout") - the event-day lock no longer covers the floor plan (0441),
// the lock bar sits at the top of Tasks & Crew and the monitor, an unlock reaches the other open pages. Pure rules, the bar on a small fake
// DOM, the wiring and the SQL text; the presses run in a browser with stub data, the SQL in tests/db/r256-layout-lock-0441.sql.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let pass = 0, fail = 0;
const t = async (n, f) => { try { await f(); pass++; } catch (e) { fail++; console.log('  FAIL ' + n + '\n       ' + e.stack.split('\n').slice(0, 3).join(' ')); } };
const EFJS = read('public/event-floor.js'), BRD = read('public/ops-board.js'), OPS = read('public/ops.html'), MON = read('public/monitor.js'), MONH = read('public/monitor.html'), MCSS = read('public/monitor.css');
const BJS = read('public/builder.js'), SQL = read('supabase/migrations/0441_r256_layout_not_locked.sql'), APPLY = read('supabase/APPLY-0441.sql'), TOURS = read('public/page-tours.js'), PACK = read('public/eventday-pack.js');
const tick = () => new Promise((r) => setImmediate(r));

function world(get) {
  class N {
    constructor(tag) { this.tag = tag; this.kids = []; this.attrs = {}; this.on = {}; this.hidden = false; this._t = ''; this.className = ''; this.style = {}; this.isConnected = true; }
    appendChild(n) { this.kids.push(n); n.parentNode = this; return n; } insertBefore(n) { return this.appendChild(n); }
    removeChild(n) { this.kids = this.kids.filter((k) => k !== n); } get firstChild() { return this.kids[0]; }
    setAttribute(k, v) { this.attrs[k] = v; if (k === 'id') this.id = v; } removeAttribute(k) { delete this.attrs[k]; }
    addEventListener(k, f) { this.on[k] = f; } click() { return this.on.click({ currentTarget: this }); }
    get textContent() { return this._t + this.kids.map((k) => k.textContent).join(''); } set textContent(v) { this._t = v; this.kids = []; }
    all() { return this.kids.flatMap((k) => [k, ...k.all()]); } find(id) { return this.all().find((n) => n.id === id); }
    querySelector(s) { const ids = s.match(/#[\w-]+/g); return ids ? this.all().find((n) => ids.includes('#' + n.id)) || null : null; }
    scrollIntoView() { this.scrolled = true; } focus() { world.focus = this.id; } getAttribute(k) { return this.attrs[k]; }
  }
  const L = {}, doc = { hidden: false, createElement: (x) => new N(x), createElementNS: (_, x) => new N(x), createTextNode: (s) => { const n = new N('#'); n._t = s; return n; }, getElementById: (id) => top.find(id) || null, addEventListener: (k, f) => { L[k] = f; }, querySelector: () => null, querySelectorAll: () => [], head: new N('head') };
  const top = new N('section'), inn = new N('section'), said = [], calls = { get: 0, floor: 0, set: [] };
  let st = get;
  const W = { document: doc, addEventListener: (k, f) => { L[k] = f; }, BPUI: { toast: (m) => said.push(m) }, BPStore: { ops: { planLock: { get: async () => { calls.get++; return { ...st }; }, floor: async () => { calls.floor++; return { items: [], lock: { ...st } }; }, set: async (q, l, r) => { calls.set.push([q, l, r]); st = { ...st, locked: l, state: l ? 'locked' : 'unlocked' }; return { ...st }; } } } } };
  let clock = 1e12; const RD = Date; class D extends RD { constructor(...a) { super(...(a.length ? a : [clock])); } static now() { return clock; } }
  const cx = vm.createContext({ window: W, Date: D, Intl, Promise, Math, JSON, Object, Array, Number, isFinite, encodeURIComponent, setTimeout, console, String, Error });
  vm.runInContext(EFJS, cx);
  return { W, EF: W.HelmEventFloor, top, inn, L, said, calls, go: (ms) => { clock += ms; }, set: (x) => { st = { ...st, ...x }; } };
}
const AUTO = { locked: true, auto: true, state: null, confirmed: true, can_lock: true, can_unlock: true, history: [], auto_at: null, relocks: false };

await t('1 R257: the lock is gone - nothing is drawn while the server says it is off, also when a lock row is stored', async () => {
  const w = world({ ...AUTO, locked: false, removed: true, auto: false, can_lock: false, can_unlock: false, state: 'locked' }); w.EF.panel({ quoteId: 'q', lockHost: w.top }); await tick(); await tick();
  assert.equal(w.top.hidden, true); assert.equal(w.top.textContent, ''); assert.equal(w.EF.isClosed('q'), false);
  const c = world({ ...AUTO, locked: true, removed: true, stage: 'closed', can_unlock: false }); c.EF.panel({ quoteId: 'q', lockHost: c.top }); await tick(); await tick(); assert.equal(c.top.hidden, true); assert.equal(c.EF.isClosed('q'), true);
});
await t('2a a database without 0442 that still refuses: one line + Unlock, only for who may; with one press', async () => {
  let n = 0; const w = world(AUTO), o = { quoteId: 'q', lockHost: w.top, onChange: () => n++ }; w.EF.panel(o); await tick(); await tick(); n = 0;
  assert.equal(w.top.hidden, false); assert.match(w.top.textContent, /needs database update 0442/); assert.equal(w.top.all().filter((x) => x.tag === 'button').length, 1);
  await w.top.find('efUnlock').click(); await tick(); assert.deepEqual(w.calls.set, [['q', false, 'The event-day lock was removed (R257)']]); assert.equal(n, 1); assert.equal(w.top.hidden, true);
  const v = world({ ...AUTO, can_unlock: false }); v.EF.panel({ quoteId: 'q', lockHost: v.top }); await tick(); await tick(); assert.equal(v.top.hidden, true);
});
await t('2b the state is read again on return and at the next refresh; nothing asked twice', async () => {
  const w = world({ ...AUTO, locked: false, removed: true, stage: 'event_day' }), o = { quoteId: 'q', lockHost: w.top }; w.EF.panel(o); await tick(); await tick();
  w.L.focus(); assert.equal(w.calls.get, 0, 'just read'); w.go(4000); w.set({ locked: true, stage: 'closed' }); w.L.focus(); w.L.visibilitychange(); await tick(); await tick(); assert.equal(w.calls.get, 1); assert.equal(w.EF.isClosed('q'), true); assert.equal(w.calls.floor, 1);
});
await t('3a Tasks & Crew and the monitor: no Lock plan, no history, no lock buttons', () => {
  for (const f of [BRD, OPS, MON, MONH, MCSS]) assert.ok(!/LockIn|lockIn|mon-lockwrap|goLock|Lock plan|🔒/.test(f.replace(/R257: no Lock plan any more/, ''))); assert.ok(!/ef-hist|efReason|History \(/.test(EFJS));
});
await t('3c the planner: no lock bar, no locked view only; a closed event stays view only; a refusal before 0441 points to Tasks & Crew', () => {
  for (const f of ['builder', 'capture', 'try']) assert.ok(!/event-floor/.test(read('public/' + f + '.html')), f);
  assert.ok(!/lockBar|Locked for the event day|bLock/.test(BJS)); assert.match(BJS, /q\.lifecycleStage==='closed'\) applyReadonly\(null,'🔒 This event is closed/);
  assert.match(BJS, /LK\.isLockError\(e\)\) BPUI\.toast\('Not saved: this event is locked for its day\. Unlock it on Tasks & Crew, then save again\./);
  assert.match(BJS, /if\(currentQuoteGuard\.closed\)/); assert.match(BJS, /if\(!editable\) applyReadonly\(await BPStore\.auth\.role\(\)\)/);
});
await t('3d the floor plan card: no Locked chip, Edit in the planner while locked, not on a closed event', () => {
  assert.ok(!/🔒 Locked"|ef-chip/.test(EFJS)); assert.match(EFJS, /var closed = \(f\.lock \|\| \{\}\)\.stage === "closed"/); assert.ok(!/lk\.locked/.test(EFJS.slice(EFJS.indexOf('function renderFloor'), EFJS.indexOf('function plannerUrl'))));
  assert.ok(!/final plan\.|Plan locked/.test(PACK)); assert.doesNotMatch(TOURS, /plan lock|Lock plan/i);
});
await t('4 SQL 0441: only functions, latest 0397 bodies + the change, kept bodies, pinned, one-line undo, paste safe', () => {
  const code = SQL.replace(/--[^\n]*/g, '');
  assert.ok(!/\b(drop|truncate|delete\s+from|alter\s+table|create\s+table|create\s+temp)\b/i.test(code)); assert.ok(/^[\x00-\x7f]*$/.test(SQL)); assert.ok(!/^\\/m.test(APPLY));
  for (const f of ['_r397_tg_versions()', '_r397_tg_quote()', 'event_plan_lock_get(p_quote uuid)', 'event_plan_lock_set(p_quote uuid']) assert.ok(code.includes('create or replace function public.' + f), f);
  for (const f of ['_r397_tg_tasks', '_r397_tg_runsheet', '_r397_tg_dayplan', '_r397_locked', '_r397_guard', '_r397_auto']) assert.ok(!code.includes('create or replace function public.' + f + '('), f + ' untouched');
  assert.equal((code.match(/security definer set search_path = ''/g) || []).length, 7); assert.match(SQL, /UNDO, one line/); assert.match(SQL, /__pre0441/);
  const old = read('supabase/migrations/0397_r227_event_plan_lock.sql'), body = (s) => s.slice(s.indexOf('create or replace function public.event_plan_lock_set'), s.indexOf('end $fn$;', s.indexOf('create or replace function public.event_plan_lock_set'))).replace(/ r256-0441\n/, '\n').replace(/\n[^\n]*-- r256-0441:[^\n]*/, '').replace("'unlocked', v_auto or public._r441_on_day(p_quote),", "'unlocked', v_auto,");
  assert.equal(body(SQL), body(old), 'lock / unlock = the 0397 body + "holds on the event day"');
  assert.ok(APPLY.includes(SQL.trimEnd())); assert.match(APPLY, /\nbegin;\n/); assert.match(APPLY, /\ncommit;\n$/); assert.match(read('supabase/migrations/MANIFEST'), /\nforward  supabase\/migrations\/0441_r256_layout_not_locked\.sql\n/);
  assert.match(read('scripts/db-test/run-all.sh'), /R256-LAYOUT-LOCK-0441: ALL PASS \\\(24\/24\\\)/);
});
console.log(`\nR256 layout lock: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
