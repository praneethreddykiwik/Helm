// R262: the payment notice opens the quotation; client page, booklet and invitation in the same quotation; stock by name with what is free; one vendor for several products
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const A = require('../public/flow-after.js'), DONE = require('../public/flow-done.js'), L = require('../public/inventory-layout.js'), V = require('../public/stock-vendor.js'), J = (x) => JSON.parse(JSON.stringify(x));
const FLOW = read('public/flow.html'), STORE = read('public/store-api.js'), DEEP = read('supabase/functions/comms-dispatch/deeplink.js'), PF = read('public/payment-followup.js');

test('1 the notices of one quotation open that quotation, in the bell and in e-mails', () => {
  for (const s of [STORE, DEEP]) {
    assert.ok(s.includes('if (k === "payment_claimed") return "flow.html?quote=" + enc(q) + "#sec-pay"'));
    assert.ok(s.includes('if (/^(quote_approved|approved)$/.test(k)) return "flow.html?quote=" + enc(q) + "#sec-pay"'));
    assert.ok(s.includes('if (/^(approval_link|otp)$/.test(k)) return "flow.html?quote=" + enc(q) + "#sec-approve"'));
  }
});
test('2 the claim is on step 10, hides only its amount, never replaces a typed amount, and goes away when answered', () => {
  assert.match(FLOW, /id="pay_claim" role="status" hidden/); assert.match(PF, /amt\.dataset\.typed === "1"/); assert.match(PF, /c\.id !== old\.claim/); assert.match(PF, /m\.setAttribute\("data-money", ""\)/);
  assert.match(FLOW, /if\(e\.isTrusted\) \$\("#pay_amount"\)\.dataset\.typed/); assert.match(PF, /go\.click\(\)/);
});
test('3 order on the page: payment, share, invitation, Done; no new link is made for the client page', () => {
  const pos = ['sec-approve', 'sec-pay', 'sec-after', 'sec-invite', 'sec-done'].map((i) => FLOW.indexOf('id="' + i + '"')); assert.deepEqual(pos.slice().sort((a, b) => a - b), pos);
  const s = read('public/flow-after.js'); assert.doesNotMatch(s, /generateToken|innerHTML|insertAdjacentHTML|\.style\b/); assert.doesNotMatch(s, /\u2014/);
});
test('4 a new invitation starts from the quote; a saved one keeps what the full editor set', () => {
  const f = A.prefill({ title: 'Asha & Dev Wedding', eventType: 'Wedding', eventDate: '2026-12-01', eventTime: '18:00', client: { name: 'Demo \u00b7 Sam', phone: '+91' } }, { venue_name: 'Lake Hall' }, { formatTime: () => '6:00 PM' });
  assert.deepEqual([f.names, f.headline, f.template, f.time, f.venue, f.host], ['Asha & Dev', 'are getting married', 'eternal', '6:00 PM', 'Lake Hall', 'Sam']);
  const site = { template: 'eternal', event_type: 'wedding', data: { names: 'A', photos: ['p'], rsvpForm: true, addressMode: 'after_rsvp', venue: 'Old' }, private_data: { address: 'Hidden road', hostPhone: '99' } };
  const form = A.fromSite(site); assert.equal(form.address, 'Hidden road'); form.venue = 'New';
  const p = A.merge(site, form); assert.deepEqual(J([p.data.photos, p.data.rsvpForm, p.data.addressMode, p.data.venue, p.data.address, p.data.hostPhone]), [['p'], true, 'after_rsvp', 'New', 'Hidden road', '99']);
  assert.equal(A.changed(form, A.fromSite(site)), true); assert.equal(A.changed(A.fromSite(site), A.fromSite(site)), false);
  assert.deepEqual(J(A.whenOff({ eventDate: '2026-12-02', eventTime: '18:00' }, { date: '2026-12-01', time: '18:00' }, {})), { date: '2026-12-02' });
  assert.equal(A.problem({ data: { names: 'A', date: '2026-12-01', rsvpBy: '2026-12-05' } }).length > 0, true); assert.equal(A.problem({ data: { names: 'A', date: '2026-12-01' } }), '');
});
test('5 Done names the booklet and the invitation, without blocking', () => {
  const full = { client: 1, date: 1, time: 1, guests: 5, venue: 1, menu: 1, layout: 1, quote: 1, plan: true, approved: 1, advance: 1, booklet: false, invite: false };
  const s = DONE.summary(full); assert.equal(s.ready, true); assert.deepEqual(s.optional.map((i) => i.key), ['booklet', 'invite']);
});
test('6 a chair is one per seat and a table one per table; 70 per seat is named with one press to fix', () => {
  assert.equal(L.ownThing('Chiavari chair'), 'seats'); assert.equal(L.ownThing('Bar stool'), 'seats'); assert.equal(L.ownThing('Round table 5ft'), 'objects'); assert.equal(L.ownThing('Chair cover'), '');
  const t = [{ layout_type: 'table', label: 'Round Table', objects: 9, seats: 70, links: [{ item_id: 'c', per_object: 70, count_mode: 'seats' }] }], s = L.sumOf({ item_id: 'c', name: 'Chiavari chair' }, t);
  assert.equal(s.text, '70 seats \u00d7 70 each = 4,900'); assert.equal(s.odd.length, 1); assert.equal(s.odd[0].seats, true);
  t[0].links[0].per_object = 2; assert.equal(L.sumOf({ item_id: 'c', name: 'Napkin' }, t).odd.length, 0, 'napkins may be 2 per seat');
});
test('7 the stock items by name: the fitting ones first, what is free, what one press takes', () => {
  const r = L.choices([{ id: 'b', name: 'Conference Chair' }], [{ id: 'a', name: 'Water goblet' }, { id: 'b', name: 'Conference Chair' }, { id: 'z', name: 'Off', active: false }], 70, (id) => ({ a: 500, b: 40 })[id]);
  assert.deepEqual(r.map((x) => [x.id, x.fit, x.free, x.take, x.short]), [['b', true, 40, 40, 30], ['a', false, 500, 70, 0]]);
});
test('8 a request for several products counts for each of them, once', () => {
  const d = { vendors: [{ id: 'v', name: 'Sample Rentals' }], needs: [{ id: 'n1', label: 'DJ Booth' }, { id: 'n2', label: 'Dance Floor' }], bookings: [{ id: 'bk', vendor_id: 'v', label: 'several', status: 'enquiry' }],
    requests: [{ id: 'r', status: 'sent', vendor_id: 'v', booking_id: 'bk', lines: [{ id: 'l1', name: 'DJ Booth', qty: 1, need_id: 'n1' }, { id: 'l2', name: 'Dance Floor', qty: 2, need_id: 'n2' }] }] };
  assert.deepEqual(V.sourcing({ label: 'Dance Floor' }, d).map((x) => [x.qty, x.status]), [[2, 'enquiry']]); assert.equal(V.sourcing({ label: 'Stage' }, d).length, 0);
  d.requests[0].status = 'accepted'; d.requests[0].offer = { status: 'approved', lines: [{ id: 'l2', qty: 1 }] }; assert.deepEqual(V.sourcing({ label: 'Dance Floor' }, d).map((x) => [x.qty, x.status]), [[1, 'booked']]);
  d.bookings[0].need_id = 'n1'; assert.equal(V.sourcing({ label: 'DJ Booth' }, d).length, 1, 'its own booking is not counted twice');
  d.requests[0].status = 'rejected'; assert.equal(V.sourcing({ label: 'Dance Floor' }, d).length, 0);
});
test('9 the vendor is asked about the product', () => {
  const s = read('public/vendor-request.js'); assert.match(s, /Yes, product available/); assert.match(s, /Are these products available\?/); assert.doesNotMatch(s, /I'm available/); assert.match(s, /"vo-n" \+ i/);
});
test('10 an approved price stays on the vendor\'s invoice; the approved quotation is one closed line', () => {
  const s = read('public/vendor-request.js'), q = read('supabase/migrations/0452_r262_invoice_price_lock.sql'); assert.match(s, /function locked\(\)/); assert.match(s, /p\.input\.readOnly = true/); assert.match(read('public/vendor-request.html'), /id="vi-lock"/);
  assert.match(q, /before insert on public\.vendor_invoices/); assert.ok(!/^\s*(drop|delete|truncate|update)\b/im.test(q)); assert.ok(read('supabase/APPLY-0452.sql').includes(q)); assert.ok(!/[^\x00-\x7f]/.test(q));
  assert.match(read('public/vendor-flow.js'), /"Approved quotation"/); assert.match(read('public/vendor-requests-ui.js'), /if \(ob && !r\.offer_open\) c\.appendChild\(ob\)/);
});
test('11 Budget and one event\'s stock page say things once', () => {
  const m = read('public/money-header-ui.js'); assert.match(m, /"As planned"/); assert.match(m, /if \(!\(same && !h\.closed/); assert.match(read('public/inventory-layout.js'), /t\.hidden = !!S\.quoteId/);
});
test('12 the monitor shows the whole run-sheet under now / next', () => {
  const m = read('public/monitor.js'); assert.match(m, /"Full run-sheet \("/); assert.match(m, /det\.open = S\.runOpen !== false/); assert.match(read('public/monitor.css'), /\.mon-run-all>summary/);
});
test('13 Pre-event on the monitor has the Approvals list of that event, the same code as the page', () => {
  const a = read('public/approvals.js'), h = read('public/monitor.html'), m = read('public/monitor.js');
  assert.match(a, /if \(!PAGE\) return;/); assert.match(a, /global\.HelmApprovals\.embed = embed/); assert.match(a, /if \(!d && EM\) \{ EM\.none = true; EM\.host\.hidden = true; return; \}/);
  assert.ok(h.indexOf('id="monPreList"') < h.indexOf('id="monApprove"') && h.indexOf('task-status.js') < h.indexOf('approvals.js?v='));
  assert.match(m, /S\.win === "pre" && e\.status !== "cancelled"/); assert.match(m, /A\.hide\(\); return;/);
});
