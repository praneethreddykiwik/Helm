// R252 (owner, 25 Nov): "I want the payment plan like a drop down like 3 part payment, 2 part payment, 4 part payment or custom" + "a fixed
// advance percentage ... but there should be override" + the issues found on staging (hidden confirm, "client approved", step 5, picker today,
// inventory wait). Everything new in the database (0435) is feature-detected: without it the screens are as they were.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const read = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const FL = read('public/flow.html'), EV = read('public/event.html'), JS = read('public/payment-schedule.js'), ADVJS = read('public/advance-percent.js'), API = read('public/store-api.js'),
  SET = read('public/payment-schedule-settings.js'), CC = read('public/control.html'), INV = read('public/inventory.html'), PICK = read('public/ui-pickers.js'), CSS = read('public/payment-schedule.css'),
  SQL = read('supabase/migrations/0435_r252_payment_plan.sql');

class El {
  constructor(t) { this.tagName = t.toUpperCase(); this.children = []; this.a = {}; this.ev = {}; this.hidden = false; this.disabled = false; this.className = ''; this._t = ''; this.isConnected = true; this.value = ''; this.classList = { add: (c) => { this.className += ' ' + c; } }; }
  get firstChild() { return this.children[0] || null; }
  get textContent() { return this._t + this.children.map((c) => c.textContent).join(''); } set textContent(v) { this.children.length = 0; this._t = String(v); }
  appendChild(c) { this.children.push(c); if (this.tagName === 'SELECT' && c.selected) this.value = c.value; return c; } removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; }
  setAttribute(k, v) { this.a[k] = v; } addEventListener(e, f) { (this.ev[e] = this.ev[e] || []).push(f); } fire(e) { return Promise.all((this.ev[e] || []).map((f) => f({ preventDefault() {} }))); } focus() {}
  all(p, o = []) { for (const c of this.children) { if (c.all) { if (p(c)) o.push(c); c.all(p, o); } } return o; }
  querySelector(s) { return this.all((e) => e.tagName === s.toUpperCase())[0] || null; } querySelectorAll() { return []; }
}
globalThis.document = { createElement: (t) => new El(t), createTextNode: (s) => ({ textContent: s }) };
require('../public/payment-schedule.js'); require('../public/advance-percent.js');
const PS = globalThis.HelmPaySchedule, ADV = globalThis.HelmAdvance, TD = '2026-11-24', EVD = '2026-12-14';
const wait = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 1)); };
const OLD = [{ key: 'builtin:30-50-20', name: '30 / 50 / 20' }, { key: 'builtin:50-50', name: '50 / 50' }, { key: 'builtin:100-upfront', name: '100% upfront' }], NEW = [...OLD, { key: 'builtin:25-25-25-25', name: '25 / 25 / 25 / 25' }], OWN = { key: 't1', name: 'Our plan' };
const data = (o = {}) => ({ rows: [], total: 100000, today: TD, event_date: EVD, can_edit: true, can_pause: true, templates: [...NEW, OWN], default_template: 'builtin:30-50-20', reminders: { enabled: false }, ...o });
async function mount(d, opts = {}, st = {}) {
  const log = [], toasts = []; globalThis.BPUI = { toast: (t, o) => toasts.push((o && o.type) + ':' + t) };
  globalThis.BPStore = { paySchedule: { forQuote: async () => d, settings: async () => { log.push('settings'); return { can_edit: st.canSave !== false, templates: [{ id: 't1', key: 't1', lines: [{ label: 'Token', kind: 'fixed', value: 10000, anchor: 'approval', offset_days: 0 }, { label: 'Rest', kind: 'balance', anchor: 'event', offset_days: -5 }] }] }; },
    apply: async (q, k, p) => { log.push((p ? 'preview:' : 'apply:') + k); return { schedule: [] }; }, pause: async (q, p) => { log.push('pause:' + p); },
    applyCustom: async (q, l, p) => { log.push(['custom', l, p]); if (st.refuse) throw new Error('no'); return st.missing ? null : { applied: true }; }, saveTemplate: async (id, n, l) => { log.push(['save', n, l]); if (st.saveFails) throw new Error('There is already a payment schedule called "' + n + '".'); }, advanceGet: async () => st.adv || null } };
  const box = new El('div'); PS.mount(box, 'q1', opts); await wait();
  const sel = box.all((e) => /psch-sel\b/.test(e.className) && e.tagName === 'SELECT')[0], btn = (t) => box.all((e) => e.tagName === 'BUTTON' && e.textContent === t)[0], rows = () => box.all((e) => /psch-erow/.test(e.className));
  const pick = async (v) => { sel.value = v; await sel.fire('change'); await wait(); }, by = (l) => box.all((e) => e.a['aria-label'] === l)[0], type = async (l, v) => { const e = by(l); e.value = v; await e.fire('input'); };
  return { box, log, toasts, sel, btn, rows, pick, by, type, total: () => box.all((e) => /psch-total/.test(e.className))[0] };
}
const vals = (m) => m.rows().map((r) => r.all((e) => e.a['aria-label'] && / percent$| amount$/.test(e.a['aria-label']))[0].value);

test('the dropdown: full, 2, 3, 4, custom, then the studio\'s own; without 0435 only the fixed ones', async () => {
  let m = await mount(data()); assert.deepEqual(m.sel.children.map((o) => o.textContent), ['Full payment', '2 payments', '3 payments', '4 payments', 'Custom', 'Our plan']); assert.equal(m.sel.value, '3');
  assert.match(m.box.textContent, /How will the client pay\?/); assert.deepEqual(m.log, ['preview:builtin:30-50-20'], 'nothing more is asked until someone picks');
  m = await mount(data({ templates: OLD })); const off = m.sel.children.filter((o) => o.disabled); assert.deepEqual(off.map((o) => o.textContent), ['4 payments (needs a database update)', 'Custom (needs a database update)']);
  assert.equal(m.rows().length, 0, 'nothing to type in'); await m.pick('2'); await m.btn('Add this schedule').fire('click'); await wait(); assert.ok(m.log.includes('apply:builtin:50-50')); assert.ok(!m.log.some((x) => Array.isArray(x)));
  for (const [k, c] of [['builtin:100-upfront', 'full'], ['builtin:25-25-25-25', '4'], ['t1', 'tpl:t1'], [null, '3']]) assert.equal(PS.choiceOf(k, NEW), c);
});
test('the local four-payment split and the built-ins are the server\'s', () => {
  const b = JSON.parse('[' + SQL.slice(SQL.indexOf('{"key":"builtin:30-50-20"'), SQL.indexOf(']$b$::jsonb')) + ']'); assert.equal(b.length, 4);
  for (const x of b) assert.deepEqual(PS.linesFor(PS.choiceOf(x.key, b), { templates: b.map((t) => ({ key: t.key, name: t.name })) }, null), x.lines);
});
test('an untouched choice = the old apply; a change = apply_custom with the checked lines; nothing is sent while the total is off', async () => {
  let m = await mount(data()); await m.btn('Add this schedule').fire('click'); await wait(); assert.ok(m.log.includes('apply:builtin:30-50-20'));
  m = await mount(data()); await m.type('Payment 1: percent', '40'); assert.match(m.total().textContent, /add up to 110% - 10% too much\./); assert.equal(m.btn('Add this schedule').disabled, true);
  await m.btn('Add this schedule').fire('click'); assert.ok(!m.log.some((x) => Array.isArray(x)));
  await m.btn('Fit the last payment to 100%').fire('click'); assert.deepEqual(vals(m), ['40', '50', '10']); await m.btn('Add this schedule').fire('click'); await wait();
  const c = m.log.find((x) => Array.isArray(x)); assert.equal(c[2], false); assert.deepEqual(c[1], [{ label: 'Advance (40%)', kind: 'percent', value: 40, anchor: 'approval', offset_days: 0 }, { label: 'Second payment (50%)', kind: 'percent', value: 50, anchor: 'event', offset_days: -15 }, { label: 'Final balance (10%)', kind: 'percent', value: 10, anchor: 'event', offset_days: 0 }]);
  m = await mount(data()); await m.type('Payment 1: percent', '40'); await m.btn('Back to the standard split').fire('click'); await m.btn('Add this schedule').fire('click'); await wait(); assert.ok(m.log.includes('apply:builtin:30-50-20'));
  m = await mount(data(), {}, { missing: true }); await m.type('Payment 1: name', 'Token'); await m.btn('Add this schedule').fire('click'); await wait(); assert.match(m.toasts.join(), /needs a database update/);
});
test('add / remove 1..8, make equal, custom keeps what is there', async () => {
  const m = await mount(data()); for (let i = 0; i < 9; i++) await m.btn('+ Add a payment').fire('click'); assert.equal(m.rows().length, 8); assert.equal(m.btn('+ Add a payment').disabled, true); assert.equal(m.sel.value, 'custom');
  await m.btn('Make equal').fire('click'); assert.deepEqual(vals(m), ['12', '12', '12', '12', '13', '13', '13', '13']); assert.match(m.total().textContent, /Total 100%/);
  for (let i = 0; i < 9; i++) await m.box.all((e) => e.textContent === 'Remove' && e.tagName === 'BUTTON')[0].fire('click'); assert.equal(m.rows().length, 1); assert.match(m.total().textContent, /87% is missing/);
});
test('a fresh plan starts from the advance %; the studio default is shown as it is', async () => {
  const st = { adv: { pct: 20 } }; const m = await mount(data(), {}, st); assert.deepEqual(vals(m), ['30', '50', '20']); await m.pick('2'); assert.deepEqual(vals(m), ['20', '80']); await m.pick('4'); assert.deepEqual(vals(m), ['20', '27', '27', '26']);
  await m.pick('full'); assert.deepEqual(vals(m), ['100']); const n = await mount(data(), { advancePct: () => null }, st); await n.pick('2'); assert.deepEqual(vals(n), ['50', '50'], 'no advance set: the standard split');
  assert.deepEqual(PS.withAdvance(PS.partsFrom(PS.BUILTINS[2].lines, 1), 30).map((x) => x.value), [100]);
});
test('amounts, dates and days: what is sent, and the checks', () => {
  const p = (o) => ({ label: 'A', unit: 'percent', value: 50, when: 'approval', days: '', date: '', ...o });
  const L = PS.partLines([p({ unit: 'fixed', value: 40000 }), p({ value: 60, when: 'date', date: '2026-12-01' })], 100000, TD, EVD); assert.deepEqual(L.map((l) => [l.kind, l.value, l.anchor, l.offset_days]), [['fixed', 40000, 'approval', 0], ['balance', null, 'event', -13]]); assert.ok(PS.cleanLines(L).ok);
  assert.deepEqual(PS.compute(PS.cleanLines(L).lines, 100000, TD, EVD).map((r) => [r.amount, r.due_date]), [[40000, TD], [60000, '2026-12-01']]);
  assert.equal(PS.partLines([p({ when: 'date', date: '2026-12-01' })], 1, TD, null)[0].anchor, 'approval', 'no event date: days from today');
  assert.equal(PS.checkParts([p({ unit: 'fixed', value: 40000 }), p({ value: 60 })], 100000, TD).ok, true);
  for (const [x, re] of [[p({ value: 0 }), /more than 0/], [p({ label: ' ' }), /give it a name/], [p({ when: 'before', days: 0 }), /1 to 365/], [p({ when: 'date', date: '2026-11-01' }), /in the past/], [p({ when: 'date' }), /choose a date/], [p({ value: '' }), /enter a percent/]]) assert.match(PS.checkParts([x, p()], 1000, TD).error, re);
  const f = PS.switchUnit(p({ label: 'Advance (30%)', auto: true, value: 30 }), 'fixed', 100000); assert.deepEqual([f.value, f.label], [30000, 'Advance']); assert.equal(PS.switchUnit(f, 'percent', 100000).value, 30);
  const t = PS.partsFrom([{ label: 'Token', kind: 'fixed', value: 51000, anchor: 'approval', offset_days: 0 }, { label: 'Half', kind: 'percent', value: 50, anchor: 'event', offset_days: 3 }, { label: 'Rest', kind: 'balance', anchor: 'event', offset_days: 0 }], 1180000); assert.deepEqual(t.map((x) => x.value), [51000, 50, 45.68]); assert.equal(PS.checkParts(t, 1180000, TD).ok, true);
});
test('save as my studio\'s plan: only with the right, only a changed plan, a name is needed, a failed save says so', async () => {
  let m = await mount(data(), {}, { canSave: false }); await m.pick('2'); await m.type('Payment 1: name', 'Token'); assert.equal(m.box.all((e) => e.className === 'psch-save')[0].hidden, true);
  m = await mount(data()); await m.pick('2'); const sv = () => m.box.all((e) => e.className === 'psch-save')[0]; assert.equal(sv().hidden, true, 'a built-in is there already'); await m.type('Payment 1: name', 'Token'); assert.equal(sv().hidden, false);
  const cb = sv().all((e) => e.type === 'checkbox')[0], nm = m.by('Name of the plan'); cb.checked = true; await cb.fire('change'); assert.equal(nm.value, '50 / 50'); nm.value = ''; await m.btn('Add this schedule').fire('click'); await wait(); assert.ok(!m.log.some((x) => Array.isArray(x)));
  nm.value = 'Weddings'; await m.btn('Add this schedule').fire('click'); await wait(); assert.deepEqual(m.log.filter(Array.isArray).map((x) => x[0]), ['custom', 'save']); assert.match(m.toasts.join(), /Saved as your studio's plan/);
  m = await mount(data(), {}, { saveFails: true }); await m.pick('2'); await m.type('Payment 1: name', 'Token'); const c2 = m.box.all((e) => e.className === 'psch-save')[0].all((e) => e.type === 'checkbox')[0]; c2.checked = true; await c2.fire('change'); await m.btn('Add this schedule').fire('click'); await wait(); assert.match(m.toasts.join(), /was added to this event, but it was not saved for the studio/);
});
test('the studio\'s saved plan: its lines, applied by its key when untouched; reminders are put back when the plan is refused', async () => {
  let m = await mount(data()); await m.pick('tpl:t1'); assert.deepEqual(vals(m), ['10000', '90']); await m.btn('Add this schedule').fire('click'); await wait(); assert.ok(m.log.includes('apply:t1'));
  m = await mount(data({ reminders: { enabled: true } }), { early: () => true }, { refuse: true }); await m.type('Payment 1: name', 'Token'); await m.btn('Add this schedule').fire('click'); await wait(); assert.deepEqual(m.log.filter((x) => /^pause/.test(x)), ['pause:true', 'pause:false']);
  m = await mount(data({ held: true, reminders: { enabled: true } }), { early: () => true }); assert.match(m.box.textContent, /Before that, nothing is sent/); await m.btn('Add this schedule').fire('click'); await wait(); assert.ok(!m.log.includes('pause:true'), '0435 holds the reminders: the tick starts empty');
});
test('advance: words, the form\'s checks, only when the studio fixed it', async () => {
  assert.deepEqual([ADV.usable(null), ADV.usable({ pct: 30, fixed: false }), ADV.usable({ pct: null, fixed: true }), ADV.usable({ pct: 30, fixed: true }), ADV.usable({ pct: 0, fixed: true })], [false, false, false, true, true]);
  let w = ADV.words({ pct: 30 }); assert.equal(w.head + w.note, "Advance 30% (your studio's setting)"); w = ADV.words({ pct: 30, override: { pct: 40, by: 'Asha', reason: 'Agreed on the phone' } }); assert.equal(w.head + w.note, 'Advance 40% - changed by Asha: Agreed on the phone'); assert.equal(w.pct, 40);
  for (const [p, r, ok] of [['40', 'Agreed', true], ['0', 'Agreed', true], ['101', 'Agreed', false], ['-1', 'Agreed', false], ['', 'Agreed', false], ['40', 'abcd', false], ['40', '  a b  ', false], ['40', '<b>hello', false]]) assert.equal(ADV.check(p, r).ok, ok, p + '/' + r);
  const log = []; let a = { pct: 30, fixed: true, can_override: true, override: null }; globalThis.BPStore = { paySchedule: { advanceGet: async () => a, advanceSet: async (q, p, r) => { log.push([p, r]); a = { ...a, override: { pct: p, reason: r, by: 'Me' } }; }, advanceClear: async () => { log.push('clear'); a = { ...a, override: null }; } } }; globalThis.BPUI = { toast() {}, confirm: async () => true };
  const seen = [], box = new El('div'); ADV.mount(box, { quoteId: 'q1', onChange: (x) => seen.push(x) }); await wait(); assert.equal(box.hidden, false); const b = (t) => box.all((e) => e.tagName === 'BUTTON' && e.textContent === t)[0];
  await b('Change for this quote').fire('click'); const inp = box.all((e) => e.tagName === 'INPUT'); inp[0].value = '40'; inp[1].value = 'abc'; await box.querySelector('form').fire('submit'); assert.deepEqual(log, []); inp[1].value = 'Agreed on the phone'; await box.querySelector('form').fire('submit'); await wait(); assert.deepEqual(log, [[40, 'Agreed on the phone']]); assert.match(box.textContent, /40% - changed by Me: Agreed on the phone/); assert.deepEqual(seen.at(-1), { pct: 40, changed: true });
  await b('Undo').fire('click'); await wait(); assert.equal(log.at(-1), 'clear'); a = { ...a, can_override: false }; const v = new El('div'); ADV.mount(v, { quoteId: 'q1' }); await wait(); assert.equal(v.all((e) => e.tagName === 'BUTTON').length, 0, 'no link without the right');
  a = null; const n = new El('div'); ADV.mount(n, { quoteId: 'q1', onChange: (x) => seen.push(x) }); await wait(); assert.equal(n.hidden, true); assert.equal(seen.at(-1), null, 'an older database: the box on the page stays');
});
test('a money question while amounts are hidden: the one PIN unlock, hidden again afterwards, never revealed without it', async () => {
  assert.match(ADVJS, /addEventListener\("click", function \(\) \{ HP\.show\(\); \}\)/); assert.match(ADVJS, /if \(shown\) \{ try \{ if \(!HP\.isHidden\(\)\) HP\.hide\(\);/); assert.doesNotMatch(ADVJS, /reveal|innerHTML|hbp-skip|realText/); assert.match(ADVJS, /querySelector\("\[data-close\]"\)/, 'the focus goes to Cancel after the PIN');
  const calls = []; globalThis.BPUI = { confirm: async (t, o) => { calls.push([t, o]); return true; } }; globalThis.HelmPrivacy = { isHidden: () => false, show() {} }; assert.equal(await ADV.ask('confirm', 'q', { title: 't' }), true); assert.deepEqual(calls, [['q', { title: 't' }]]); delete globalThis.HelmPrivacy;
  assert.equal((FL.match(/await moneyAsk\("(confirm|alert)",/g) || []).length, 3, 'record, over the balance, re-price'); assert.doesNotMatch(FL, /BPUI\.(confirm|alert)\([^)]*inr\((amount|d\.)/);
});
test('flow: the advance is text only when fixed; the amount stays editable; the plan\'s first part is offered', () => {
  assert.match(FL, /id="pay_pct" type="number" min="0" max="100" value="10"/); assert.match(FL, /ADV_FIX=a;[^]{0,160}const w=document\.querySelector\("\.pay-f-pct"\); if\(w\) w\.hidden=!!a;/); assert.match(FL, /id="pay_amount" type="number" min="0"><\/div>/);
  assert.match(FL, /if\(!ADV_TYPED && document\.activeElement!==\$\("#pay_amount"\)\)/); assert.match(FL, /You can still record it if this is what the client paid/); assert.match(FL, /Use the plan's first part/); assert.match(FL, /" - not the "\+Math\.round\(pct\*100\)\/100\+"% advance\."/);
  const rec = FL.slice(FL.indexOf('async function recordPayment()'), FL.indexOf('// QA1026 #13')); assert.doesNotMatch(rec, /paintAdvDiff|pay_adv_diff|setStage/, 'the warning never blocks, the page never moves the stage'); assert.doesNotMatch(FL, /setStage|set_lifecycle_stage/);
});
function shareRun(ev, paid, o = {}) {
  const fn = FL.slice(FL.indexOf('function approvedOnText(){'), FL.indexOf('let shareFrom=null;'));
  const S = new Function('$', 'document', 'state', `let sharePaid=false, PAID_SUM=state.paid, ev=state.ev, APPR=state.appr; function clientApproved(){ const ap=(ev&&(ev.approvalStatus||ev.approval_status))||""; return sharePaid || PAID_SUM>0 || ap==="approved" || ap==="paid"; }
    ${fn} CONSENT=state.consent; return syncShare;`);
  const n = {}, nodes = new Proxy(n, { get: (x, k) => (k in x ? x[k] : (x[k] = { hidden: false, textContent: '', checked: true, dataset: {}, open: true })) }); S((s) => nodes[s], { querySelectorAll: () => [] }, { ev, paid, appr: o.appr || null, consent: o.consent === undefined ? null : o.consent })(); return nodes;
}
test('"the client approved" is said only when the client did', () => {
  const pend = 'Confirmed by advance - client approval pending';
  for (const o of [{ appr: { basis: 'advance' } }, { consent: false }]) { const n = shareRun({ approvalStatus: 'paid' }, 5000, o); assert.equal(n['#csApproved'].textContent, pend); assert.doesNotMatch(n['#csDoneNote'].textContent + n['#apSub'].textContent, /client has approved/); assert.match(n['#csDoneNote'].textContent, /has not approved/); }
  for (const o of [{ appr: { basis: 'client' } }, { consent: true }]) { const n = shareRun({ approvalStatus: 'paid' }, 5000, o); assert.match(n['#csApproved'].textContent, /^Approved ✓/); assert.match(n['#csDoneNote'].textContent, /The client has approved/); }
  const u = shareRun({ approvalStatus: 'none' }, 5000); assert.equal(u['#csApproved'].textContent, 'Booking confirmed by the advance'); assert.equal(shareRun({ approvalStatus: 'approved' }, 0)['#csApproved'].textContent, 'Approved ✓');
  assert.match(FL, /CONSENT=Array\.isArray\(acts\)\?acts\.some\(a=>a&&a\.kind==="consent"\):null/); assert.match(EV, /ap\.basis==="advance"\?' The client has not approved yet\.'/);
  const f = new Function(API.slice(API.indexOf('  function approvalWords('), API.indexOf('  // r20 coord (b): ONE "advance is in" rule')) + ' return approvalWords;')();
  assert.deepEqual(f('paid', { basis: 'advance' }), { label: pend, detail: 'by the advance - client has not approved' }); assert.equal(f('paid', null).label, 'Booking confirmed by the advance'); assert.equal(f('paid', { basis: 'client' }).label, 'Client approved'); assert.deepEqual(f('approved'), { label: 'Client approved', detail: 'approved' }); assert.equal(f(null).detail, 'link not sent yet');
  assert.match(API, /\{ key: "approval", \.\.\.approvalWords\(ev\.approvalStatus, basis && basis\[0\]\), critical: true, ok: \["approved", "paid"\]\.includes\(ev\.approvalStatus\) \}/, 'the ok rule is as it was');
});
test('step 5 counts the saved dishes and the lock', () => {
  assert.match(FL, /if\(s==="menu" && \(appliedPkg \|\| menuDishes\(\)>0 \|\| !!\(plan&&plan\.menu_locked\)\)\) return true;/); assert.match(FL, /menu:\(!!appliedPkg \|\| !!persisted\.menu \|\| menuDishes\(\)>0\) && !bad\("menu"\)/); assert.match(FL, /\[lk\?"Locked":"", n\?n\+\(n===1\?" dish":" dishes"\):""\]/);
});
test('the date picker\'s today is the studio\'s day', () => {
  const src = PICK.slice(PICK.indexOf('  function studioToday() {'), PICK.indexOf('  /* ---- positioning:')); const run = (B) => { const c = { window: { BPStore: B }, Date, String }; vm.createContext(c); return vm.runInContext(src + ';studioToday()', c); };
  const d = run({ todayLocal: () => '2026-11-25' }); assert.deepEqual([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()], [2026, 10, 25, 0]); assert.ok(!isNaN(run(undefined))); assert.match(PICK, /today = studioToday\(\);/); assert.doesNotMatch(PICK, /today = new Date\(\)/); assert.match(PICK, /pick\(iso\(today\)\)/);
});
test('inventory: the items show on their own answer, counts and lists follow, no new read', () => {
  const ld = INV.slice(INV.indexOf('  async function load(){'), INV.indexOf('  function applyLoans(')); assert.match(ld, /await Promise\.allSettled\(\[itemsP, availP, ctxReady\]\)/); assert.ok(ld.indexOf('renderStock();') < ld.indexOf('await restP'), 'the list never waits for check-outs or layouts');
  assert.equal((ld.match(/BPStore\.inventory\.items\(/g) || []).length, 1); assert.match(INV, /Promise\.all\(\[itemsP,ctxReady\]\)\.then/, 'unit costs wait for what this person may see'); assert.match(INV, /availPending\?'<span class="sk w40 skr"/, 'never a made-up count');
  assert.match(INV, /bootItems=BPStore\.inventory\.items\(showInactive\); bootItems\.catch/); assert.match(ld, /const itemsP=bootItems\|\|BPStore\.inventory\.items\(showInactive\); bootItems=null;/, 'the early read IS the load\'s read');
});
test('store + settings: every 0435 call is feature-detected; the % is saved through the pricing settings', () => {
  for (const r of ['payment_schedule_apply_custom', 'advance_get', 'advance_override_set', 'advance_override_clear', 'quote_approval_basis']) { assert.ok(API.includes('rpc("' + r + '"'), r); assert.ok(SQL.includes('function public.' + r + '('), r); }
  for (const r of ['payment_schedule_apply_custom', 'advance_get', 'quote_approval_basis']) assert.match(API, new RegExp('rpc\\("' + r + '"[^;]*?rpcMissing\\(e\\)\\) return null'));
  assert.match(SET, /HelmPricingCfg\.save\(\{ advancePct: ac\.pct \}\)/); assert.match(SET, /if \(fx && mayFix\(\) && fx\.checked !== S\.advance_fixed\) patch\.advance_fixed = fx\.checked;/); assert.match(CC, /const next=Object\.assign\(\{\}, pricingCfg, patch\); await BPStore\.config\.setPricing\(next\); pricingCfg=next;/); assert.match(CC, /id="pst_fixrow" hidden/);
  const c = { setTimeout() {}, document: { readyState: 'x', getElementById: () => null } }; vm.createContext(c); vm.runInContext(SET, c); const k = c.HelmPayScheduleSettings.advCheck;
  assert.deepEqual([k('30', 30).changed, k('35', 30).changed, k('', null).ok, k('', 30).ok, k('101', 30).ok, k('-1', 30).ok, k('12.5', null).pct], [false, true, true, false, false, false, 12.5]);
});
test('CSP + phone: no HTML strings, no inline style, 44px', () => { for (const s of [JS, ADVJS, SET]) assert.doesNotMatch(s, /innerHTML|insertAdjacentHTML|\.style\b/); assert.match(CSS, /\.psch-in\{[^}]*min-height:44px/); assert.match(CSS, /@container \(max-width:520px\)/); assert.match(FL, /advance-percent\.js\?v=\d+/); });
