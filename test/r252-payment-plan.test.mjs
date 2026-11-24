// R252 (owner, 24 Nov): "the payment schedule and plan will be done at the quote and advance payment time, right" - the plan sits right after the
// Next cards while the event is Lead .. Confirmed, the quote flow's share step says whether it is set, and a reminder can not reach a client
// who has not approved by accident. Amounts, rules and the server are unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const read = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const EV = read('public/event.html'), FL = read('public/flow.html'), JS = read('public/payment-schedule.js');

class El {
  constructor(t) { this.tagName = t.toUpperCase(); this.children = []; this.childNodes = this.children; this.a = {}; this.ev = {}; this.hidden = false; this.className = ''; this._t = ''; this.isConnected = true; this.value = ''; this.style = {};
    this.classList = { add: (c) => { this.className += ' ' + c; } }; }
  get firstChild() { return this.children[0] || null; }
  get textContent() { return this._t + this.children.map((c) => c.textContent).join(''); } set textContent(v) { this.children.length = 0; this._t = String(v); }
  appendChild(c) { this.children.push(c); if (this.tagName === 'SELECT' && c.selected) this.value = c.value; return c; } removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; }
  setAttribute(k, v) { this.a[k] = v; } addEventListener(e, f) { (this.ev[e] = this.ev[e] || []).push(f); } fire(e) { return Promise.all((this.ev[e] || []).map((f) => f({}))); }
  all(p, o = []) { for (const c of this.children) { if (c.all) { if (p(c)) o.push(c); c.all(p, o); } } return o; }
}
globalThis.document = { createElement: (t) => new El(t), createTextNode: (s) => ({ textContent: s }) };
require('../public/payment-schedule.js');
const PS = globalThis.HelmPaySchedule;
const wait = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 1)); };
const TPL = [{ key: 'builtin:30-50-20', name: '30 / 50 / 20' }, { key: 'builtin:50-50', name: '50 / 50' }];
const data = (o = {}) => ({ rows: [], total: 100000, can_edit: true, can_pause: true, paused: false, templates: TPL, default_template: 'builtin:50-50', reminders: { enabled: true, before_days: 3, on_due: true, every_days: 3, max_overdue: 1 }, ...o });
const ROW = [{ label: 'Advance (30%)', amount: 30000, paid: 0, remaining: 30000, state: 'due', due_date: '2026-11-24' }];
async function mount(d, opts, store = {}) {
  const log = []; globalThis.BPStore = { paySchedule: { forQuote: async () => { if (store.fail) throw store.fail; return d; }, settings: async () => { log.push('settings'); if (store.noSettings) throw new Error('x'); return { auto_apply: store.auto !== false }; },
    pause: async (q, p) => { log.push('pause:' + p); }, apply: async (q, k, prev) => { if (prev) return { schedule: [] }; log.push('apply:' + k); if (store.refuse) throw new Error('no'); } } };
  const box = new El('div'); PS.mount(box, 'q1', opts); await wait(); return { box, log };
}
const btn = (b, t) => b.all((e) => e.tagName === 'BUTTON' && e.textContent === t)[0];
const boxEl = (b) => b.all((e) => e.tagName === 'INPUT' && /^psch_hold_/.test(e.id || ''))[0];
const early = { early: () => true };

test('the automatic plan is named, honestly', async () => {
  assert.equal(PS.autoPlan(data(), true).text, 'If you choose nothing, Helm adds “50 / 50” when the client approves.');
  assert.match(PS.autoPlan(data(), false).text, /Nothing is added by itself/); assert.equal(PS.autoPlan(data(), null).text, '');
  let m = await mount(data(), early); assert.match(m.box.textContent, /Helm adds “50 \/ 50” when the client approves/);
  m = await mount(data(), early, { auto: false }); assert.match(m.box.textContent, /automatic plan is off in Settings/);
  m = await mount(data({ can_edit: false }), early, { auto: false }); assert.doesNotMatch(m.box.textContent, /added automatically/);
  m = await mount(data(), { ...early, autoLine: false }); assert.doesNotMatch(m.box.textContent, /Helm adds/, 'the quote flow says it in its own line');
  m = await mount(data(), early, { noSettings: true }); assert.doesNotMatch(m.box.textContent, /Helm adds|Nothing is added/);
});
test('without the new options the card is as before: no extra read, no extra words', async () => {
  const m = await mount(data(), {}); assert.deepEqual(m.log, []); assert.match(m.box.textContent, /^Payment schedule/); assert.equal(boxEl(m.box), undefined);
  const n = await mount(data({ rows: ROW }), early); assert.deepEqual(n.log, [], 'a plan is set: the automation setting is not asked');
});
test('before approval: reminders are paused first, then the plan is added; unticked = plan only', async () => {
  let m = await mount(data(), early); assert.equal(boxEl(m.box).checked, true); await btn(m.box, 'Add this schedule').fire('click'); await wait();
  assert.deepEqual(m.log.filter((x) => x !== 'settings'), ['pause:true', 'apply:builtin:50-50']);
  m = await mount(data(), early); boxEl(m.box).checked = false; await btn(m.box, 'Add this schedule').fire('click'); await wait(); assert.deepEqual(m.log.filter((x) => x !== 'settings'), ['apply:builtin:50-50']);
  m = await mount(data(), early, { refuse: true }); await btn(m.box, 'Add this schedule').fire('click'); await wait(); assert.deepEqual(m.log.filter((x) => x !== 'settings'), ['pause:true', 'apply:builtin:50-50', 'pause:false'], 'not added: reminders as they were');
  for (const o of [{ paused: true }, { can_pause: false }, { reminders: { enabled: false } }]) { const x = await mount(data(o), early); assert.equal(boxEl(x.box), undefined); }
  const y = await mount(data(), { early: () => false }); assert.equal(boxEl(y.box), undefined);
});
test('a plan that is already there: the reminder risk before approval, the paused reminders after it', async () => {
  let m = await mount(data({ rows: ROW }), early); assert.match(m.box.textContent, /could get a payment reminder before they approve/);
  m = await mount(data({ rows: ROW, paused: true }), early); assert.doesNotMatch(m.box.textContent, /could get a payment reminder/);
  m = await mount(data({ rows: ROW, paused: true }), { early: () => false, approved: () => true }); assert.match(m.box.textContent, /reminders are still paused/);
  m = await mount(data({ rows: ROW, paused: true }), {}); assert.doesNotMatch(m.box.textContent, /still paused/);
});
test('title and intro follow the stage; refused stays hidden, no answer is said', async () => {
  let m = await mount(data(), { title: () => 'Payment plan', intro: () => 'Set it first.' }); assert.match(m.box.textContent, /^Payment plan.*Set it first\./);
  let f = 0, n = 0; const o = { onFail: () => f++, onNone: () => n++ };
  m = await mount(null, o, { fail: Object.assign(new Error('not authorized'), { code: '42501' }) }); assert.equal(m.box.hidden, true); assert.deepEqual([f, n], [0, 1]);
  m = await mount(null, o, { fail: new Error('Failed to fetch') }); assert.equal(m.box.hidden, true); assert.deepEqual([f, n], [1, 1]);
});
test('event page: after the Next cards until Confirmed, below Money at a glance from Planning on', () => {
  assert.match(EV, /const planEarly=\(\)=> !!ev && !evLocked\(\) && stageIndex\(effStage\(\)\)<stageIndex\("planning"\);/);
  const pos = ['id="mods"', 'id="moneyHeader"', 'id="paySchedCard"'].map((x) => EV.indexOf(x)); assert.ok(pos[0] < pos[1] && pos[1] < pos[2]);
  assert.match(EV, /if\(up\)\{ if\(c\.nextElementSibling!==mh\) mh\.parentNode\.insertBefore\(c,mh\); \}/);
  assert.match(EV, /Set it before you send the quote - the client's advance comes from the first line\./);
  assert.match(EV, /if\(!canFin \|\| !id \|\| !window\.HelmPaySchedule\) return; placePayPlan\(\);/);
});
test('quote flow: step 9 says if a plan is set, one press chooses it, sending is never blocked', () => {
  const share = FL.slice(FL.indexOf('id="shareBody"'), FL.indexOf('id="sec-pay"')); assert.ok(share.indexOf('id="csPlan"') < share.indexOf('id="sendApproval"'));
  assert.equal(FL.split('id="paySchedule"').length, 2, 'one card, moved, never two'); assert.match(FL, /if\(card\.parentNode!==to\) to\.appendChild\(card\);/);
  const send = FL.slice(FL.indexOf('No quotation total saved yet. Send anyway?') - 700, FL.indexOf('No quotation total saved yet. Send anyway?') + 3500); assert.doesNotMatch(send, /PLAN|csPlan|paySched/);
  const fn = FL.slice(FL.indexOf('function placePlan'), FL.indexOf('function pressPlan')); assert.doesNotMatch(fn, /innerHTML|\.style\b/); assert.match(fn, /M\$\(f\.amount\)/, 'amounts are maskable');
  assert.match(FL, /onNone:\(\)=>\{ planState\(null\); advanceFrom\(null\); \}, onFail:\(\)=>planState\("fail"\)/);
});
test('the advance amount changes only when pressed; recording is as it was', () => {
  assert.match(FL, /const amt=ADV_PLAN \? line1\.rem : Math\.round\(tot\*pct\/100\);/); assert.match(FL, /let ADV_PLAN=false;/);
  assert.match(FL, /\$\("#pay_plan1b"\)\.addEventListener\("click",usePlanFirst\)/); assert.match(FL, /ADV_PLAN=false; updateAdvance\(\); \}\);/);
  assert.equal((FL.match(/ADV_PLAN=true/g) || []).length, 1); assert.match(FL, /BPStore\.milestones\.record\(id, amount, method,/);
  assert.doesNotMatch(JS, /innerHTML/);
});
