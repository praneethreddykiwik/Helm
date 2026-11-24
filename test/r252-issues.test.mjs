// R252: issues organised + optional person (public/issue-assign.js - Tasks & Crew, monitor, issues.html).
//   1 pure: order, filters, how long open, the picker's groups, who is on this event
//   2 behaviour on a small fake DOM: assign / change / clear, the task only with the tick, one per press, refusals, locked plan
//   3 wiring of the three pages, setOwner, Back, safety
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); } };
const JS = read('public/issue-assign.js'), CSS = read('public/issue-assign.css'), BRD = read('public/ops-board.js'), MON = read('public/monitor.js'), ISS = read('public/issues.html'), STORE = read('public/store-api.js');
const plain = (x) => JSON.parse(JSON.stringify(x));
const tick = async () => { for (let i = 0; i < 25; i++) await new Promise((r) => setTimeout(r, 0)); };

let DOC;
class El {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.attrs = {}; this.childNodes = []; this.parentNode = null; this.ev = {}; this.hidden = false; this._t = null; this.disabled = false; this.checked = false; this._v = ''; const n = this;
    this.classList = { add: (...c) => { n.className = [...new Set([...(n.className || '').split(' '), ...c])].join(' '); } }; }
  get className() { return this.attrs.class || ''; } set className(v) { this.attrs.class = v; }
  get firstChild() { return this.childNodes[0] || null; }
  get textContent() { return this._t != null ? this._t : this.childNodes.map((c) => c.textContent).join(''); } set textContent(v) { this.childNodes = []; this._t = String(v); }
  get value() { return this._v; } set value(v) { this._v = this.tagName !== 'SELECT' || this.all().some((o) => o.tagName === 'OPTION' && (o.attrs.value || '') === v) ? v : ''; }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'disabled') this.disabled = true; } getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  appendChild(c) { this._t = null; if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.childNodes.push(c); return c; } removeChild(c) { this.childNodes = this.childNodes.filter((x) => x !== c); c.parentNode = null; return c; }
  contains(n) { while (n) { if (n === this) return true; n = n.parentNode; } return false; }
  addEventListener(e, f) { (this.ev[e] = this.ev[e] || []).push(f); } fire(e, o) { (this.ev[e] || []).forEach((f) => f(Object.assign({ preventDefault() {}, stopPropagation() {}, currentTarget: this }, o))); }
  focus() { DOC.activeElement = this; }
  all() { return this.childNodes.flatMap((c) => c.all ? [c, ...c.all()] : []); }
  querySelector(s) { const m = /^\[data-key="(.*)"\]$/.exec(s); return this.all().find((n) => m ? n.attrs['data-key'] === m[1] : (n.className || '').split(' ').includes(s.slice(1))) || null; }
}
const txt = (s) => ({ textContent: s, parentNode: null });
function world(o = {}) {
  DOC = { createElement: (x) => new El(x), createTextNode: txt, activeElement: null };
  const calls = [], can = Object.assign({ staff: true, vendors: true }, o.can), tasks = (o.tasks || []).slice();
  const W = (n, f) => async (...a) => { calls.push([n, ...a]); if (o.fail === n) throw Object.assign(new Error('x'), { code: 'zz' }); return f ? f(...a) : true; };
  const store = { auth: { canView: async (k) => !!can[k], canAssignTasks: async () => o.canTask !== false },
    people: { options: async () => o.people || [{ id: 'c1', name: 'Asha Rao', kind: 'staff', role: 'Decor' }, { id: 'c2', name: 'Ravi Kumar', kind: 'staff' }, { id: 'v1', name: 'Sri Caterers', kind: 'vendor', role: 'Catering' }, { id: 'v2', name: 'Bright Lights', kind: 'vendor' }] },
    bookings: { list: async () => [{ vendor_id: 'v2', status: 'confirmed' }, { vendor_id: 'v1', status: 'cancelled' }] },
    quotes: { get: async () => ({ eventDate: '2026-11-29' }) }, calendar: { wouldClash: async () => o.clash || { clash: false } },
    issues: { setOwner: W('setOwner') },
    ops: { listCrew: async () => [{ id: 'c1', name: 'Asha Rao', phone: '+919800000001', email: 'a@x.test' }, { id: 'c2', name: 'Ravi Kumar', phone: '' }], listTasks: W('listTasks', () => tasks.slice()),
      assignTasks: W('assignTasks', (q, c, ti, id, n) => { tasks.push({ id: 'n' + tasks.length, category: c, title: ti[0], crew_id: id, assignee_name: n, status: 'assigned' }); }),
      assignTasksVendor: W('assignTasksVendor', (q, c, ti, id) => { tasks.push({ id: 'n' + tasks.length, category: c, title: ti[0], vendor_id: id, status: 'assigned' }); }),
      setSchedule: W('setSchedule'), planLock: { get: async () => ({ locked: !!o.locked }) } } };
  const win = { document: DOC, BPStore: store, BPUI: { friendlyError: (e, x) => 'Couldn’t ' + x.action + '.', confirm: async () => o.confirm !== false } };
  vm.runInNewContext(JS, { window: win, Date, Math, Number, String, Object, Array, JSON, isFinite, Promise });
  return { IA: win.HelmIssueAssign, calls, tasks, host: new El('div'), n: (k) => calls.filter((c) => c[0] === k).length };
}
const NOW = Date.now(), ago = (m) => new Date(NOW - m * 60000).toISOString();
const ITEMS = [{ id: 'l', title: 'Chairs', severity: 'low', status: 'in_progress', owner: 'Asha Rao', created_at: ago(5) }, { id: 'm1', title: 'Old', severity: 'medium', status: 'open', owner: 'Mr. Iyer', created_at: ago(90) },
  { id: 'm2', title: 'New', severity: 'medium', status: 'open', created_at: ago(10) }, { id: 'h', title: 'Generator', severity: 'high', status: 'open', created_at: ago(200) }, { id: 'd', title: 'Fuse', severity: 'high', status: 'resolved', resolved_at: ago(3), created_at: ago(400) }];
const opts = (w, x) => Object.assign({ items: ITEMS, quoteId: 'q1', canEdit: true, reload: async () => {}, toast: (m, k) => w.calls.push(['toast', m, k]) }, x);
const btn = (h, k) => h.querySelector('[data-key="' + k + '"]');
async function choose(w, id, key, task) { btn(w.host, 'ia:a:' + id).fire('click'); await tick(); const sel = w.host.querySelector('.hia-sel'); if (key != null) { sel.value = key; sel.fire('change'); } await tick();
  const chk = w.host.all().find((n) => n.attrs.type === 'checkbox'); if (task) chk.checked = true; return { sel, chk, form: w.host.querySelector('.hia-form') }; }

await t('1a order: open High, Medium, Low, newest first; resolved apart; filters; how long open', () => {
  const P = world().IA._pure, g = P.organise(ITEMS); assert.deepEqual(plain(g.open.map((i) => i.id)), ['h', 'm2', 'm1', 'l']); assert.deepEqual(plain(g.done.map((i) => i.id)), ['d']);
  assert.deepEqual(plain(g.open.filter((i) => P.pass(i, 'none')).map((i) => i.id)), ['h', 'm2']); assert.deepEqual(plain(g.open.filter((i) => P.pass(i, 'high')).map((i) => i.id)), ['h']);
  assert.deepEqual([P.openFor(ago(0), NOW), P.openFor(ago(25), NOW), P.openFor(ago(65), NOW), P.openFor(ago(600), NOW), P.openFor(ago(60 * 24 * 2), NOW), P.openFor('', NOW)], ['just now', 'open 25 min', 'open 1 h 5 min', 'open 10 h', 'open 2 days', '']);
});
await t('1b groups: this event first, staff before vendors, cancelled work or bookings do not count, same name found again', () => {
  const P = world().IA._pure, on = P.onEvent([{ crew_id: 'c1', status: 'assigned' }, { crew_id: 'c2', status: 'cancelled' }], [{ vendor_id: 'v2', status: 'confirmed' }, { vendor_id: 'v1', status: 'cancelled' }]);
  const g = P.groups({ options: [{ id: 'v1', name: 'A Vendor', kind: 'vendor' }, { id: 'c2', name: 'Ravi', kind: 'staff' }, { id: 'v2', name: 'B Vendor', kind: 'vendor' }, { id: 'c1', name: 'Asha', kind: 'staff' }, { id: 'c1', name: 'Asha', kind: 'staff' }], ...on });
  assert.deepEqual(plain(g.map((x) => [x.label, x.list.map((y) => y.key)])), [['Staff - working this event', ['staff:c1']], ['Other staff', ['staff:c2']], ['Vendors of this event', ['vendor:v2']], ['Other vendors', ['vendor:v1']]]);
  assert.equal(P.byName(g, ' asha ').key, 'staff:c1'); assert.equal(P.byName(g, 'nobody'), null);
});
await t('2a assign: only the name is written, no task without the tick; an unchanged name writes nothing', async () => {
  const w = world(); w.IA.list(w.host, opts(w)); const c = await choose(w, 'h', 'staff:c1'); c.form.fire('submit'); await tick();
  assert.deepEqual(w.calls.filter((x) => x[0] === 'setOwner'), [['setOwner', 'h', 'Asha Rao']]); assert.equal(w.n('assignTasks'), 0); assert.match(w.calls.at(-1)[1], /^Assigned to Asha Rao\.$/);
  const w2 = world(); w2.IA.list(w2.host, opts(w2)); const c2 = await choose(w2, 'l', null); assert.equal(c2.sel.value, 'staff:c1', 'the person who has it is chosen'); c2.form.fire('submit'); await tick(); assert.equal(w2.n('setOwner'), 0);
  const w3 = world(); w3.IA.list(w3.host, opts(w3)); const c3 = await choose(w3, 'l', ''); c3.form.fire('submit'); await tick(); assert.deepEqual(w3.calls.filter((x) => x[0] === 'setOwner'), [['setOwner', 'l', null]]);
});
await t('2b someone else: a typed name, kept as it was, never empty', async () => {
  const w = world(); w.IA.list(w.host, opts(w)); const c = await choose(w, 'm1', null), name = w.host.querySelector('.hia-inp'); assert.equal(c.sel.value, 'other'); assert.equal(name.value, 'Mr. Iyer');
  name.value = '  '; name.fire('input'); c.form.fire('submit'); await tick(); assert.equal(w.n('setOwner'), 0); assert.match(w.host.querySelector('.hia-err').textContent, /Type their name/);
  name.value = ' Hall   manager '; c.form.fire('submit'); await tick(); assert.deepEqual(w.calls.filter((x) => x[0] === 'setOwner')[0], ['setOwner', 'm1', 'Hall manager']);
});
await t('2c the tick: one task per press (double submit too), category Issue, starts now; e-mail words; asked again = not twice', async () => {
  const w = world(); w.IA.list(w.host, opts(w)); const c = await choose(w, 'h', 'staff:c1', true); c.form.fire('submit'); c.form.fire('submit'); await tick();
  assert.deepEqual(plain(w.calls.filter((x) => x[0] === 'assignTasks')), [['assignTasks', 'q1', 'Issue', ['Generator'], 'c1', 'Asha Rao', '+919800000001']]); assert.equal(w.n('setOwner'), 1);
  const s = w.calls.find((x) => x[0] === 'setSchedule'); assert.equal(s[1], 'n0'); assert.ok(Math.abs(Date.parse(s[2]) - Date.now()) < 61000); assert.match(w.calls.find((x) => x[0] === 'toast')[1], /by e-mail/);
  const pick = { kind: 'staff', id: 'c1', name: 'Asha Rao', task: true }; const r = await w.IA.giveTask('q1', 'Generator', pick); assert.ok(r.ok && r.same); assert.equal(w.n('assignTasks'), 1);
  const [a, b] = await Promise.all([w.IA.giveTask('q1', 'Other', pick), w.IA.giveTask('q1', 'Other', pick)]); assert.equal(a, b); assert.equal(w.n('assignTasks'), 2);
});
await t('2d vendor: the vendor call; nothing promises an e-mail; the earlier person is named', async () => {
  const w = world({ tasks: [{ id: 'x', category: 'Issue', title: 'Generator', crew_id: 'c1', assignee_name: 'Asha Rao', status: 'assigned' }] }); const r = await w.IA.giveTask('q1', 'Generator', { kind: 'vendor', id: 'v2', name: 'Bright Lights' });
  assert.deepEqual(plain(w.calls.filter((x) => x[0] === 'assignTasksVendor')), [['assignTasksVendor', 'q1', 'Issue', ['Generator'], 'v2']]); assert.doesNotMatch(r.msg, /e-mail/); assert.match(r.msg, /Asha Rao still has it as a task/);
});
await t('2e the issue stays saved when the task fails, has no phone, or is stopped at the clash question', async () => {
  for (const [o, id, re] of [[{ fail: 'assignTasks' }, 'c1', /The task was not given/], [{}, 'c2', /no phone number/], [{ clash: { clash: true, detail: 'busy' }, confirm: false }, 'c1', /No task was given/]]) {
    const w = world(o), r = await w.IA.assign({ id: 'h', title: 'Generator', owner: null }, 'q1', { kind: 'staff', id, name: 'X', task: true });
    assert.equal(w.n('setOwner'), 1); assert.equal(r.ok, false); assert.match(r.msg, /^Assigned to X\./); assert.match(r.msg, re); assert.equal(w.tasks.length, 0);
  }
  const w = world({ fail: 'setSchedule' }), r = await w.IA.giveTask('q1', 'G', { kind: 'staff', id: 'c1', name: 'Asha Rao' }); assert.ok(r.ok); assert.match(r.msg, /start time could not be saved/);
  const w2 = world({ fail: 'listTasks' }), r2 = await w2.IA.giveTask('q1', 'G', { kind: 'staff', id: 'c1', name: 'Asha Rao' }); assert.equal(r2.ok, false); assert.equal(w2.n('assignTasks'), 0, 'unknown list = no task');
});
await t('2f the tick only with Add & assign and an unlocked plan, only for staff / vendor picks', async () => {
  let w = world({ canTask: false }); w.IA.list(w.host, opts(w)); await choose(w, 'h', 'staff:c1'); assert.equal(w.host.querySelector('.hia-task').hidden, true);
  w = world({ locked: true }); w.IA.list(w.host, opts(w)); let c = await choose(w, 'h', 'staff:c1'); assert.equal(c.chk.disabled, true); c.chk.checked = true; c.form.fire('submit'); await tick(); assert.equal(w.n('assignTasks'), 0); assert.equal(w.n('setOwner'), 1);
  w = world(); w.IA.list(w.host, opts(w)); c = await choose(w, 'h', 'other'); assert.equal(w.host.querySelector('.hia-task').hidden, true);
});
await t('2g people: a group this person may not read is left out; nothing readable = a typed name; an empty answer offers Try again', async () => {
  let w = world({ can: { staff: false } }); w.IA.list(w.host, opts(w)); await choose(w, 'h', null); assert.deepEqual(w.host.all().filter((n) => n.tagName === 'OPTGROUP').map((n) => n.attrs.label), ['Vendors of this event', 'Other vendors']);
  w = world({ can: { staff: false, vendors: false } }); w.IA.list(w.host, opts(w)); await choose(w, 'h', null); assert.match(w.host.textContent, /You can type a name/); assert.equal(w.host.all().filter((n) => n.tagName === 'OPTGROUP').length, 0);
  w = world({ people: [] }); w.IA.list(w.host, opts(w)); await choose(w, 'h', null); assert.match(w.host.textContent, /Try again/);
});
await t('2h the list: Nobody yet + Assign, folded Resolved, view only = no buttons, kept while choosing, Try again on a failed read', async () => {
  let w = world(); w.IA.list(w.host, opts(w, { resolve() {} })); assert.match(w.host.textContent, /Nobody yet/); assert.equal(btn(w.host, 'ia:a:h').textContent, 'Assign'); assert.equal(btn(w.host, 'ia:a:l').textContent, 'Change');
  assert.equal(btn(w.host, 'ia:done').textContent, 'Resolved (1)'); assert.equal(w.host.querySelector('.hia-done').open, false);
  await choose(w, 'h', 'staff:c1'); const f = w.host.querySelector('.hia-form'); assert.equal(w.IA.list(w.host, opts(w, { items: ITEMS.slice(1) })), false); assert.equal(w.host.querySelector('.hia-form'), f); assert.ok(w.IA.busy(w.host));
  w = world(); w.IA.list(w.host, opts(w, { canEdit: false, resolve() {}, remove() {} })); assert.equal(w.host.all().filter((n) => n.tagName === 'BUTTON').length, 0);
  let n = 0; w = world(); w.IA.list(w.host, opts(w, { items: [], err: true, reload: () => { n++; } })); btn(w.host, 'ia:retry').fire('click'); assert.equal(n, 1); assert.doesNotMatch(w.host.textContent, /Nothing open/);
});
await t('3a setOwner: the owner column only, trimmed, a refusal is said', () => {
  const fn = STORE.slice(STORE.indexOf('async setOwner(id, owner)'), STORE.indexOf('async remove(id)', STORE.indexOf('async setOwner(id, owner)')));
  assert.match(fn, /const patch = \{ owner: /); assert.match(fn, /update\(patch\)\.eq\("id", id\)\.select\("id"\)/); assert.match(fn, /42501/);
});
await t('3b Tasks & Crew, monitor and issues.html use the same parts; Pre-event and On the event; one filled button per step', () => {
  for (const s of [BRD, MON, ISS]) { assert.match(s, /\.picker\(\{/); assert.match(s, /IA\.list\(/); assert.match(s, /\.withTask\(/); }
  for (const s of [BRD, MON]) assert.match(s, /function issStep\(\) \{ return S\.win === "onday" \|\| S\.win === "pre"; \}/);
  assert.match(BRD, /onday: \["tcRun", "tcDelay", "tcLate", "tcIssues", "tcActCard"/); assert.match(BRD, /pre: \["tcReady", "tcDelay", "attn", "tcLate", "tcIssues", "tcCrewCard", "tcLock", "tcFloor", "work", "tcPreDone"/);
  assert.match(BRD, /\(main \? " tc-primary" : ""\), id: "tcLogIssue"/); assert.match(BRD, /if \(go\.disabled\) return;/);
  for (const p of ['public/ops.html', 'public/monitor.html', 'public/issues.html']) { const h = read(p); assert.match(h, /href="\/issue-assign\.css\?v=\d+"/); assert.match(h, /src="\/issue-assign\.js\?v=\d+"/); }
  assert.match(MON, /readiness\(S\.tasks\)\.need\.filter\(function \(t\) \{ return !inDayCard\(t\); \}\)/);
});
await t('3c issues.html: chips, Back to the page you came from (two names only, built here)', () => {
  for (const f of ['data-f=""', 'data-f="none"', 'data-f="high"']) assert.ok(ISS.includes(f));
  const src = ISS.slice(ISS.indexOf('function cameFrom()'), ISS.indexOf('BPUI.boot(async'));
  const from = (search, ref) => vm.runInNewContext(src + ';cameFrom()', { URLSearchParams, URL, location: { search, origin: 'https://h.test' }, document: { referrer: ref || '' }, HelmUrl: { parse: (p) => /\/events\/[^/]+\/tasks$/.test(p) ? { page: 'ops' } : p === '/s/budget' ? { page: 'budget' } : null } });
  assert.deepEqual([from('?from=ops'), from('?from=monitor'), from('?from=//evil'), from('', 'https://h.test/monitor?quote=1'), from('', 'https://h.test/ops.html'), from('', 'https://h.test/s/events/E-1/tasks'), from('', 'https://h.test/s/budget'), from('', 'https://evil.test/ops'), from('')], ['ops', 'monitor', '', 'monitor', 'ops', 'ops', '', '', '']);
});
await t('3d safety: no HTML strings, no inline style, no delete, no money; CSS tokens only, 44px, scoped', () => {
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(JS)); assert.ok(!/\bstyle\s*[:=]|\.style\b/.test(JS)); assert.ok(!/issues\.remove|\.delete\(|cancel\(/.test(JS)); assert.ok(!/₹|\bINR\b|\.cost\b|\.price/.test(JS)); assert.doesNotMatch(ISS, /style="flex/);
  const css = CSS.replace(/\/\*[\s\S]*?\*\//g, ''); assert.deepEqual([...css.matchAll(/#[0-9a-f]{3,8}\b/gi)].map((m) => m[0]), []); assert.match(css, /\.hia \.hia-btn\{[^}]*min-height:44px/);
  css.replace(/@media[^{]*\{/g, '').split('}').map((x) => x.split('{')[0].trim()).filter(Boolean).forEach((s) => assert.match(s, /^\.hia/, s));
});
console.log(`\nr252-issues: ${pass} passed, ${fail} failed`); if (fail) process.exit(1);
