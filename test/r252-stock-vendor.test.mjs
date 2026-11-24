// r252-stock-vendor.test.mjs - R252: "Get it from a vendor" (public/stock-vendor.js), no database: the pure rules (number, what is
// the same thing, who is already asked, what pressing the button does, which way it saves, vendor order + search) and the source rules
// (existing calls only, read again before saving, guarded, no price, nothing sent unless ticked, DOM nodes only, loaded on the pages).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const rd = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const V = createRequire(import.meta.url)('../public/stock-vendor.js');
const JS = rd('public/stock-vendor.js'), CSS = rd('public/stock-vendor.css'), SA = rd('public/store-api.js');
let n = 0;
const t = (name, fn) => { try { fn(); n++; console.log('  ok ' + name); } catch (e) { console.error('  FAIL ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; } };

t('how many: a positive whole number only', () => {
  for (const [v, r] of [['12', 12], [' 7 ', 7], [1000000, 1000000], ['0', null], ['-1', null], ['1.5', null], ['1e3', null], ['', null], [null, null], ['1000001', null], ['abc', null], ['12x', null]]) assert.equal(V.parseQty(v), r, String(v));
});
t('the same thing: by stock item, by the need, by the words, by the label the stock call writes - never another item of the same name', () => {
  const needs = [{ id: 'n1', kind: 'inventory', item_id: 'i1', label: 'Chairs' }, { id: 'n2', kind: 'other', label: 'LED  Screen' }, { id: 'n3', kind: 'staff', label: 'Sofa' }];
  assert.equal(V.findNeed({ itemId: 'i1', label: 'x' }, needs).id, 'n1'); assert.equal(V.findNeed({ label: 'led screen ' }, needs).id, 'n2');
  assert.equal(V.findNeed({ label: 'Sofa' }, needs), null); assert.equal(V.findNeed({ itemId: 'i9', label: 'chairs' }, needs), null);
  const bookings = [{ id: 'a', vendor_id: 'v1', need_id: 'n1', qty: 5, status: 'booked' }, { id: 'b', vendor_id: 'v2', label: 'Chiavari chair - rent 20 (stock shortfall)', status: 'enquiry' },
    { id: 'c', vendor_id: 'v3', need_id: 'n1', qty: 9, status: 'cancelled' }, { id: 'd', vendor_id: 'v4', label: 'Flowers', qty: 1, status: 'enquiry' }, { id: 'e', vendor_id: 'v5', label: 'renamed', qty: 3, status: 'enquiry' }];
  const l = V.sourcing({ itemId: 'i1', label: 'Chiavari chair' }, { bookings, needs, shortages: [{ item_id: 'i1', booking_id: 'e' }], vendors: [{ id: 'v1', name: 'Rao' }] });
  assert.deepEqual(l.map((x) => [x.bookingId, x.vendorName, x.qty, x.statusText, x.fromStock]), [['a', 'Rao', 5, 'Booked', false], ['b', 'Vendor', 20, 'Asked', true], ['e', 'Vendor', 3, 'Asked', true]]);
  assert.equal(V.sourcedQty(l), 28); assert.deepEqual(V.rentOf('A - b - rent 2.5 (stock shortfall)'), { name: 'A - b', qty: 2.5 }); assert.equal(V.rentOf('Rent a car'), null);
});
t('same vendor again: never a second booking - the number is changed only while it is just Asked, with no price and no stock shortfall', () => {
  const s = (o) => ({ qty: 20, status: 'enquiry', priced: false, fromStock: false, ...o });
  assert.deepEqual(V.decide(null, 5), { act: 'new' }); assert.deepEqual(V.decide(s(), 20), { act: 'exists', why: 'same' }); assert.deepEqual(V.decide(s(), 25), { act: 'update' });
  assert.equal(V.decide(s({ status: 'confirmed' }), 25).why, 'agreed'); assert.equal(V.decide(s({ priced: true }), 25).why, 'priced'); assert.equal(V.decide(s({ fromStock: true }), 25).why, 'stock');
});
t('which way it saves: nothing free = the stock call; some free = the stock call only when "reserve first" is ticked; else need + booking', () => {
  const o = { itemId: 'i', canInv: true, qty: 20 };
  assert.deepEqual(V.route({ ...o, free: 0 }), { how: 'stock', call: 20, reserve: 0 }); assert.deepEqual(V.route({ ...o, free: 40, reserveFree: true }), { how: 'stock', call: 60, reserve: 40 });
  assert.equal(V.route({ ...o, free: 40 }).how, 'need'); assert.equal(V.route({ ...o, free: null }).how, 'need'); assert.equal(V.route({ ...o, canInv: false, free: 0 }).how, 'need');
  assert.equal(V.route({ qty: 2, canInv: true, free: 0 }).how, 'need'); assert.equal(V.route({ ...o, free: 0, shortOpen: true }).how, 'need');
  assert.equal(V.shortOpen('i', [{ item_id: 'i', booking_id: null }]), true); assert.equal(V.shortOpen('i', [{ item_id: 'i', booking_id: 'b' }, { item_id: 'z' }]), false);
});
t('a need on the plan is called covered only when vendors + what is held reach it', () => {
  assert.equal(V.needMet({ qty: 120 }, 20, 100), true); assert.equal(V.needMet({ qty: 120 }, 20, 99), false); assert.equal(V.needMet({ qty: 2 }, 2, 0), true);
});
t('vendors: this event\'s first, then all, by name; cancelled bookings and switched-off vendors out; search over name, category, kind, services', () => {
  const vs = [{ id: '1', name: 'Zed', kind: 'rental', category: 'Chairs', services: ['Sofa'] }, { id: '2', name: 'abc lights', kind: 'vendor' }, { id: '3', name: 'Mno', active: false }, { id: '4', name: 'Bob', kind: 'supplier' }];
  const l = V.vendorList(vs, [{ vendor_id: '1', status: 'enquiry' }, { vendor_id: '4', status: 'cancelled' }], '');
  assert.deepEqual([l.event.map((v) => v.id), l.other.map((v) => v.id)], [['1'], ['2', '4']]);
  assert.deepEqual(V.vendorList(vs, [], 'sofa').other.map((v) => v.id), ['1']); assert.deepEqual(V.vendorList(vs, [], 'LIGHTS abc').other.map((v) => v.id), ['2']); assert.equal(V.vendorList(vs, [], 'zzz').other.length, 0);
});
t('the job: a plain title, only to a vendor with a phone number', () => {
  assert.equal(V.jobTitle('Chiavari chair', 1200), 'Bring 1,200 x Chiavari chair'); assert.ok(V.jobTitle('x'.repeat(300), 1).length <= 120);
  assert.equal(V.hasPhone({ phone: '+91 98480 22334' }), true); assert.equal(V.hasPhone({ phone: '123' }), false); assert.equal(V.hasPhone(null), false);
});
t('source: existing calls only; the event is read again right before saving; no delete, no price, off by default', () => {
  const calls = [...JS.matchAll(/S\(\)\.([a-zA-Z.]+)\(/g)].map((m) => m[1]);
  for (const c of new Set(calls)) { const last = c.split('.').pop(); assert.ok(new RegExp('\\b' + last + '\\b').test(SA), c); }
  assert.doesNotMatch(JS, /\.remove(Need|Res|Item)?\(\s*(now|res|b)\b|bookings\.remove|removeNeed|\.rpc\(|supa\b|fetch\(/);
  assert.match(JS, /readEvent\(o\)\.then\(function \(fresh\) \{\s*data = fresh;/); assert.match(JS, /if \(busy \|\| ok\.disabled\) return;/);
  assert.match(JS, /status: "enquiry"/); assert.doesNotMatch(JS, /\bcost:|advance:|agreed_amount|rate:|studioMoney|₹/);
  assert.match(JS, /type: "checkbox", id: uid \+ "j", "aria-describedby"/); assert.doesNotMatch(JS, /jobIn\.checked = true/);
  assert.match(JS, /Promise\.all\(\[may\("resources"\), may\("vendors"\)\]\)/);
});
t('source: an accessible dialog of DOM nodes (no HTML strings, no inline styles, no hex colours), 44px targets, a sheet on a phone', () => {
  assert.match(JS, /role: "dialog", "aria-modal": "true", "aria-labelledby"/); assert.match(JS, /"data-close": true/); assert.match(JS, /role: "alert"/);
  assert.doesNotMatch(JS, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\.style\.|setAttribute\(\s*["']style/);
  assert.doesNotMatch(CSS, /#[0-9a-f]{3,8}\b/i); assert.match(CSS, /min-height:44px/); assert.match(CSS, /@media \(max-width:560px\)/);
  assert.equal((CSS.match(/\{/g) || []).length, (CSS.match(/\}/g) || []).length);
});
t('loaded on Inventory, Tasks & Crew, the monitor and Readiness', () => {
  for (const p of ['inventory', 'ops', 'monitor', 'ready']) { const h = rd('public/' + p + '.html'); assert.match(h, /<script src="\/stock-vendor\.js\?v=\d+"><\/script>/, p); assert.match(h, /href="\/stock-vendor\.css\?v=\d+"/, p); }
});
console.log('\nr252-stock-vendor: ' + n + ' passed');
