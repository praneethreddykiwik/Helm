// R255 b (owner, 25 Nov, live event 11252026-01): the payment plan that was picked was never saved; the advance came from an unsaved live price
// (4,60,790 vs the approved 4,60,318); the plan moved around the page; the approval page (phone, terms message, what happens next); portal, booklet, e-mails.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const read = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const FL = read('public/flow.html'), AP = read('public/approve.html'), PO = read('public/portal.html'), BK = read('public/booklet.js'), PSJ = read('public/payment-schedule.js');

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
const leave = []; globalThis.addEventListener = (e, f) => { if (e === 'beforeunload') leave.push(f); };
require('../public/payment-schedule.js'); const PLAN = require('../public/approve-plan.js'), PS = globalThis.HelmPaySchedule;
const wait = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 1)); };
const T = [{ key: 'builtin:30-50-20', name: '30 / 50 / 20' }, { key: 'builtin:50-50', name: '50 / 50' }, { key: 'builtin:100-upfront', name: '100% upfront' }, { key: 'builtin:25-25-25-25', name: '25 / 25 / 25 / 25' }];
const data = (o = {}) => ({ rows: [], total: 460318, today: '2026-11-25', event_date: '2026-11-26', can_edit: true, templates: T, default_template: 'builtin:30-50-20', reminders: { enabled: false }, ...o });
async function mount(d, opts = {}, o = {}) {
  const log = [], flips = []; let cur = d; globalThis.BPUI = { toast: (t) => log.push('toast:' + t) };
  globalThis.BPStore = { paySchedule: { forQuote: async () => { if (cur === 'fail') throw new Error('net'); return cur; }, settings: async () => null, apply: async (q, k, p) => { log.push((p ? 'preview:' : 'apply:') + k); if (!p) cur = { ...d, rows: [{ label: 'x', amount: 1, state: 'due' }] }; return { schedule: [] }; },
    applyCustom: async (q, l) => { log.push(['custom', l]); if (o.refuse) throw new Error('no'); cur = { ...d, rows: [{ label: 'x', amount: 1, state: 'due' }], can_edit: true }; return { applied: true }; }, advanceGet: async () => null } };
  const box = new El('div'); box.hidden = false; const api = PS.mount(box, 'q1', { onDirty: (v) => flips.push(v), ...opts }); await wait();
  const btn = (t) => box.all((e) => e.tagName === 'BUTTON' && e.textContent === t)[0], chip = () => box.all((e) => /psch-st\b/.test(e.className))[0], sel = () => box.all((e) => e.tagName === 'SELECT')[0];
  return { box, log, flips, api, btn, chip, sel, set: (v) => { cur = v; }, pick: async (v) => { const s = sel(); s.value = v; await s.fire('change'); await wait(); } };
}

test('a picked plan says "Not saved yet", survives a re-read of the card, and is saved by one clear button', async () => {
  const m = await mount(data()); assert.equal(m.api.dirty(), false); assert.equal(m.chip().hidden, true); assert.ok(m.btn('Save payment plan')); assert.equal(m.btn('Add this schedule'), undefined);
  await m.pick('4'); assert.equal(m.api.dirty(), true); assert.equal(m.chip().hidden, false); assert.equal(m.chip().textContent, 'Not saved yet'); assert.deepEqual(m.flips, [true]);
  const days = m.box.all((e) => / number of days$/.test(e.a['aria-label'] || '')); days[0].value = '10'; await days[0].fire('input'); days[1].value = '5'; await days[1].fire('input');
  assert.ok(m.box.all((e) => e.textContent === 'days').length >= 2, '"15" is days, never read as 15%'); assert.match(m.box.textContent, /That day has passed, so it is due today/);
  await m.api.reload(); await wait(); assert.equal(m.api.dirty(), true); assert.equal(m.sel().value, '4'); assert.deepEqual(m.box.all((e) => / number of days$/.test(e.a['aria-label'] || '')).map((e) => String(e.value)), ['10', '5'], 'kept as typed');
  m.set('fail'); await m.api.reload(); await wait(); assert.equal(m.api.dirty(), true, 'a lost answer loses nothing'); m.set(data()); await m.api.reload(); await wait();
  assert.equal(await m.api.save(), true); await wait(); const c = m.log.find((x) => Array.isArray(x)); assert.deepEqual(c[1].map((l) => l.offset_days), [0, -10, -5, 0]); assert.equal(m.api.dirty(), false); assert.deepEqual(m.flips.at(-1), false);
  const done = m.btn('✓ Payment plan saved'); assert.equal(done.disabled, true); assert.equal(m.chip().textContent, 'Saved'); assert.ok(m.log.includes('toast:Payment plan saved.'));
});
test('a refused save keeps it unsaved; discard drops it; leaving the page asks (unless the page asks by itself)', async () => {
  let m = await mount(data(), {}, { refuse: true }); await m.pick('custom'); const n = leave.length; assert.equal(await m.api.save(), false); assert.equal(m.api.dirty(), true);
  const ev = { preventDefault() { this.stopped = true; } }; leave[n - 1](ev); assert.equal(ev.stopped, true); m.api.discard(); assert.equal(m.api.dirty(), false); const e2 = { preventDefault() { this.stopped = true; } }; leave[n - 1](e2); assert.equal(e2.stopped, undefined); assert.equal(m.sel().value, '3');
  const before = leave.length; m = await mount(data(), { ownLeave: true }); assert.equal(leave.length, before); assert.equal(await m.api.save(), true, 'nothing to save'); assert.ok(!m.log.some((x) => /^apply:/.test(x)));
});
test('flow: one order always, and nothing is sent or left behind while the plan is not saved', () => {
  const ids = ['id="sec-quote"', 'id="sec-payplan"', 'id="sec-approve"', 'id="csApprove"', 'id="sec-share"', 'id="sec-pay"'].map((x) => FL.indexOf(x)); assert.deepEqual(ids, [...ids].sort((a, b) => a - b)); assert.doesNotMatch(FL, /paySchedHome|csPlanSlot/);
  assert.match(FL, /function unsaved\(\)\{ return dirty \|\| planDirty\(\)/); assert.match(FL, /closest\("#sec-payplan,#sec-after,#sec-invite"\)\) return; const s=sectionOf/); assert.match(FL, /if\(ok && planDirty\(\)\)\{ ok=await PSCH\.save\(\)/); assert.match(FL, /if\(planDirty\(\)\) PSCH\.discard\(\);/);
  assert.match(FL, /You changed the payment plan but didn't save it\. "\+\(why\|\|"Save and send\?"\)/); assert.match(FL, /\$\("#shareBody"\)\.addEventListener\("click",guardShare,true\)/); const send = FL.slice(FL.indexOf('async function sendApproval()'), FL.indexOf('/* ---------- load ---------- */')); assert.match(send, /if\(!\(await planGate\(\)\)\) return;/);
  assert.ok(send.indexOf('await saveQuotation()') < send.indexOf('await planGate()'), 'the price first, then the plan split from it'); for (const s of ['#apprLinks button', '#sec-share .btn.primary', '#sec-share .ems-box button']) assert.ok(FL.includes(s)); assert.equal((FL.match(/await planGate\("Save and continue"/g) || []).length, 2, 'both ways into the floor builder');
});
// the money rules of flow.html, run
function money(st) {
  const src = FL.slice(FL.indexOf('  const savedTotal=()=>'), FL.indexOf('  function paintUnsaved(df){')), seed = FL.slice(FL.indexOf('  let chairsPriced=false;'), FL.indexOf('  function useSavedPrice(){'));
  const guard = require('../public/reprice-guard.js'), nodes = { '#q_chairs': { value: String(st.live) } };
  return new Function('st', 'guard', '$', `let ev=st.ev, PAID_SUM=st.paid||0, chairsManual=true, updated=0; const window={HelmRepriceGuard:guard}, BPStore={pricing:{quoteTotal:(p)=>({total:p.chairs*236+419018})}};
    const currentInputs=()=>({chairs:+$("#q_chairs").value}), quoteBlocked=()=>false, syncChairsUi=()=>{}, clientApproved=()=>["approved","paid"].includes(ev.approvalStatus);
    ${src} ${seed} return { quoteTotal, priceDiff, seedPricedChairs, live:()=>BPStore.pricing.quoteTotal(currentInputs()).total, get priced(){ return chairsPriced; }, chairs:()=>$("#q_chairs").value };`)(st, guard, (s) => nodes[s]);
}
test('money: sent / approved -> the advance and the balance use the saved 4,60,318, never the live 4,60,790', () => {
  const ev = (a, s) => ({ status: s || 'quote', approvalStatus: a, pricing: { total: 460318, chairs: 175 } });
  for (const a of ['sent', 'approved', 'paid']) { const m = money({ ev: ev(a), live: 177 }); assert.equal(Math.round(m.live()), 460790); assert.equal(m.quoteTotal(), 460318); assert.equal(Math.round(m.quoteTotal() * 30 / 100), 138095); const d = m.priceDiff(m.live()); assert.deepEqual([Math.round(d.live), d.saved, d.committed], [460790, 460318, true]); assert.equal(d.word, a === 'sent' ? 'quotation the client has' : 'approved quotation'); }
  assert.equal(money({ ev: ev('none'), live: 177, paid: 5 }).quoteTotal(), 460318, 'money in'); assert.equal(money({ ev: ev('none', 'confirmed'), live: 177 }).quoteTotal(), 460318);
  const draft = money({ ev: ev('none'), live: 177 }); assert.equal(Math.round(draft.quoteTotal()), 460790, 'a draft follows the live price, as before'); assert.equal(draft.priceDiff(draft.live()).committed, false, 'but it is said, and sending asks first');
  const fresh = money({ ev: { status: 'quote', approvalStatus: 'none', pricing: {} }, live: 177 }); assert.equal(fresh.priceDiff(fresh.live()), null);
});
test('money: a chair count the builder wrote on the client record does not re-price a quotation the client has', () => {
  const pr = { total: 460318, chairs: 175 }; let m = money({ ev: { approvalStatus: 'approved', pricing: pr }, live: 177 }); m.seedPricedChairs(false); assert.equal(String(m.chairs()), '175'); assert.equal(m.priced, true); assert.equal(m.priceDiff(m.live()), null);
  m = money({ ev: { approvalStatus: 'none', pricing: pr }, live: 177 }); m.seedPricedChairs(false); assert.equal(String(m.chairs()), '177', 'a draft is as before'); m.seedPricedChairs(true); assert.equal(String(m.chairs()), '175', '"Go back to the saved price"');
  assert.match(FL, /if\(chairsPriced\) ev\.client=keptSizing\(ev\.client\);/, 'the client record is not rewritten by what is only shown'); assert.equal((FL.match(/chairsPriced=false/g) || []).length >= 5, true);
  assert.match(FL, /data-line="unsaved"/); assert.match(FL, /The price on this page \(\$\{inr\(df\.live\)\}\) is not saved\. The client would see/);
});
test('the decor number is explained from the same lines the price uses', () => {
  assert.match(FL, /Everything in the floor layout except chairs and plates/); const fn = FL.slice(FL.indexOf('function paintOtherItems(){'), FL.indexOf('// an unsaved hand entry survives')); assert.match(fn, /pricing\.fromItems\(layoutItems\|\|\[\], rates&&rates\.assetPrices\)/); assert.match(fn, /Setup charge \(Settings\)/); assert.doesNotMatch(fn, /innerHTML/);
});
const S = { total: 460318, paid: 0, today: '2026-11-25', rows: [{ label: 'Advance (25%)', amount: 115080, due_date: '2026-11-25', state: 'due', paid: 0, remaining: 115080, on_approval: true }, { label: 'Second payment (25%)', amount: 115080, due_date: '2026-11-25', state: 'due', paid: 0, remaining: 115080 }, { label: 'Rest', amount: 230158, due_date: '2026-11-26', state: 'due', paid: 0, remaining: 230158 }], pay: { upi: 'helm@upi', note: 'HDFC 123' } };
test('approval page: the plan before the button, and what happens next after it', () => {
  let m = PLAN.model(S, false); assert.deepEqual(m.rows.map((r) => [r.name, r.pct, r.when, r.tag]), [['Advance', '25%', 'approval', 'First payment'], ['Second payment', '25%', 'date', ''], ['Rest', '50%', 'date', '']]);
  m = PLAN.model(S, true); assert.equal(m.next.tag, 'Pay now'); assert.equal(m.next.toPay, 115080); assert.deepEqual(m.pay, { upi: 'helm@upi', note: 'HDFC 123' });
  const part = PLAN.model({ ...S, paid: 138237, rows: [{ ...S.rows[0], state: 'paid', paid: 138095, remaining: 0 }, { ...S.rows[1], due_date: '2026-12-01', state: 'part_paid', paid: 142, remaining: 114938 }] }, true); assert.deepEqual([part.next.tag, part.next.toPay, part.rows[0].tag], ['Next payment', 114938, 'Paid'], 'the 142 more rolls on to the next payment');
  for (const x of [null, {}, { rows: null }]) assert.equal(PLAN.model(x, true), null); assert.equal(PLAN.model({ rows: [], total: 5 }, true).next, null); assert.equal(PLAN.model({ ...S, pay: null }, true).pay, null);
  const box = new El('div'), o = { approved: true, money: (n) => 'Rs ' + n, date: (d) => d }; assert.equal(PLAN.paint(box, PLAN.model(S, true), o), true); assert.match(box.textContent, /Pay now: Advance \(25%\)Rs 115080/); assert.match(box.textContent, /UPI: helm@upi/); assert.equal(box.all((e) => e.tagName === 'BUTTON' || e.tagName === 'A').length, 0, 'no pay button: online payment is on hold');
  assert.equal(PLAN.paint(new El('div'), PLAN.model({ rows: [] }, true), o), false); const t = new El('div'); PLAN.paint(t, PLAN.model(S, true), { ...o, how: false }); assert.doesNotMatch(t.textContent, /How to pay/, 'trial');
  assert.ok(AP.indexOf('id="planCard"') < AP.indexOf('id="flow"')); assert.match(AP, /approve-plan\.js\?v=\d+/); assert.match(AP, /setMsg\(\); afterApproved\(\);/); assert.match(AP, /b\.textContent=""; b\.hidden=true; b\.style\.display="none"; \} showPlan\("after"\)/, 'no "valid until" on an approved quote'); assert.doesNotMatch(read('public/approve-plan.js'), /innerHTML|\.style\b/);
});
test('approval page: the phone is compulsory on every channel, kept with the consent; the terms message goes when it is ticked', () => {
  assert.match(AP, /Mobile number <span class="req" aria-hidden="true">\*<\/span><\/label><input id="c_phone"[^>]*required aria-required="true"/); assert.match(AP, /<span class="req" aria-hidden="true">\*<\/span> <span id="agreeText">/);
  assert.equal((AP.match(/if\(!needPhone\(\)\) return;/g) || []).length, 2); assert.match(AP, /const ph=needPhone\(\); if\(!ph\)/); assert.match(AP, /HelmPhone\.validate\(v,\{ required:true/); assert.match(AP, /withPhone\(consentText\(shownTerms\.v\), ph\)/);
  assert.match(AP, /id="msg" role="alert" data-no-toast/); assert.match(AP, /\["#c_agree","#t_agree"\]\.forEach\(\(sel\)=>\$\(sel\)\.addEventListener\("change",\(\)=>clearMsg\(MSG_TERMS\)\)\)/);
  const P = new Function('$', 'window', 'apTax', 'setMsg', AP.slice(AP.indexOf('  let phoneMsg="";'), AP.indexOf('  // the number is kept with')).replace('let phoneMsg="";', 'let phoneMsg="";') + ' return needPhone;');
  const HP = (() => { const g = {}; new Function('window', 'document', read('public/phone-input.js').replace(/\}\)\(typeof window[^]*$/, '})(window);')).call(null, g, undefined); return g.HelmPhone; })();
  const run = (v, tax) => { const msgs = [], el = { value: v, a: {}, setAttribute(k, x) { this.a[k] = x; }, removeAttribute(k) { delete this.a[k]; }, focus() {} }; const r = P(() => el, { HelmPhone: HP }, tax, (k, t) => msgs.push(t)); return [r(), msgs[0] || '', el.a['aria-invalid'] || '']; };
  assert.deepEqual(run('', null), ['', 'Please enter your mobile number.', 'true']); assert.equal(run('12345', { country: 'IN' })[0], ''); assert.equal(run('+919876543210', { country: 'IN' })[0], '+919876543210'); assert.equal(run('+971501234567', { country: 'IN' })[0], '+971501234567', 'another country'); assert.equal(run('+14155552671', null)[0], '+14155552671');
});
test('portal: the balance once; booklet: initials, Helm green default, no "valid until" once booked; e-mails: "Label:"', async () => {
  assert.equal((PO.match(/Balance due: </g) || []).length, 1); assert.doesNotMatch(PO, /el\.textContent="Balance "/); assert.match(PO, /"Phone: "\+String/); assert.match(PO, /"Email: "\+em/);
  const f = new Function(BK.slice(BK.indexOf('  function initials(name)'), BK.indexOf('  function renderCover(d)')) + ' return initials;')(); assert.deepEqual(['Helm Studio', 'aurora', '  ', 'A & B Events', null].map(f), ['HS', 'A', '✦', 'AB', '✦']);
  assert.match(read('public/booklet.css'), /--accent:#047857/); assert.doesNotMatch(BK, /setProperty\("--accent/, 'R261: Helm green for every studio'); assert.match(BK, /if \(!booked && global\.HelmQuoteValidity/);
  const L = await import('../supabase/functions/_shared/email-layout.mjs'); const h = L.facts([['Phone', '+91 98'], ['Where?', 'x'], ['Date:', 'y']]); assert.match(h, />Phone:<\/td>/); assert.match(h, />Where\?<\/td>/); assert.match(h, />Date:<\/td>/); assert.doesNotMatch(h, /::/);
});

test('flow: the Monitor button and the menu lock follow the same rules as the event page', async () => {
  const mon = (ev, can, paid) => { const b = { hidden: true, href: '' }; new Function('$', 'ev', 'canMon', 'PAID_SUM', 'id', FL.slice(FL.indexOf('  function paintMonBtn(){'), FL.indexOf('  async function loadAll(){')) + ' paintMonBtn();')(() => b, ev, can, paid || 0, 'q 1'); return b; };
  assert.equal(mon({ status: 'confirmed', lifecycleStage: 'planning' }, true).href, 'monitor.html?quote=q%201'); assert.equal(mon({ status: 'quote' }, true, 5).hidden, false, 'the advance confirmed it');
  for (const [e, c, p] of [[{ status: 'quote' }, true], [{ status: 'confirmed' }, false], [{ status: 'cancelled' }, true, 5], [{ status: 'confirmed', lifecycleStage: 'closed' }, true], [{ status: 'confirmed', lifecycleStage: 'settlement' }, true]]) assert.equal(mon(e, c, p).hidden, true);
  assert.match(FL, /BPStore\.auth\.canView\("staff"\),BPStore\.auth\.canEditArea\("plan"\)/); assert.match(read('public/monitor.js'), /requireView\("staff"\)/);
  const lock = async (o) => { const n = {}, $ = (k) => (n[k] = n[k] || { hidden: false, textContent: '' }), calls = [];
    const src = FL.slice(FL.indexOf('  const menuIsLocked=()=>'), FL.indexOf('  function mountDishEditor(){'));
    const f = new Function('$', 'o', 'calls', `let plan=o.plan||null, ev=o.ev||{status:"confirmed"}, canPlan=o.can!==false, canEdit=true, appliedPkg=o.pkg||null, failed={}, persisted={}, AS=null, edited=new Set(), id="q"; const menuDishes=()=>0, paintMenuBadge=()=>{}, updateProgress=()=>{}, dishEd={setEditable:(v)=>calls.push("edit:"+v)};
      const BPUI={confirm:async()=>o.yes!==false,guard:async(b,fn)=>fn(),toast:(t)=>calls.push(t),friendlyError:()=>"refused"}, BPStore={plan:{setLock:async(q,v)=>{calls.push("lock:"+v); if(o.refuse) throw new Error("no");}, get:async()=>({menu_locked:!o.lockedNow})}}; ${src} return {paintMenuLock,pressMenuLock};`)($, o, calls);
    f.paintMenuLock(); const before = { hid: n['#menuLock'].hidden, btn: n['#menuLockBtn'].hidden, t: n['#menuLockBtn'].textContent, note: n['#menuLockNote'] && n['#menuLockNote'].textContent }; if (o.press) await f.pressMenuLock(); return { ...before, calls, after: n['#menuLockBtn'].textContent }; };
  let r = await lock({ pkg: { id: 1 }, press: true }); assert.deepEqual([r.hid, r.btn, r.t, r.after], [false, false, 'Lock the menu', 'Unlock']); assert.deepEqual(r.calls, ['lock:true', 'edit:false', 'Menu locked.']); assert.match(r.note, /^Planning needs the menu locked\.$/);
  r = await lock({ plan: { menu_locked: true }, press: true, lockedNow: true }); assert.deepEqual([r.t, r.after], ['Unlock', 'Lock the menu'].map((x, i) => i ? 'Lock the menu' : x)); assert.ok(r.calls.includes('lock:false'));
  r = await lock({}); assert.equal(r.btn, true); assert.match(r.note, /Pick a package/); r = await lock({ pkg: { id: 1 }, ev: { status: 'confirmed', consentStale: true } }); assert.equal(r.btn, true);
  assert.equal((await lock({ pkg: { id: 1 }, can: false })).hid, true); assert.equal((await lock({ pkg: { id: 1 }, ev: { status: 'cancelled' } })).hid, true); r = await lock({ pkg: { id: 1 }, press: true, yes: false }); assert.deepEqual(r.calls, []); r = await lock({ pkg: { id: 1 }, press: true, refuse: true }); assert.deepEqual([r.calls.at(-1), r.after], ['refused', 'Lock the menu']);
});
