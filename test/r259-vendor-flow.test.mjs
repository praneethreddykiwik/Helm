// r259-vendor-flow.test.mjs - R259 (0447): one vendor flow.
//  A  0447: additive, pinned, guarded, gates kept, MANIFEST + APPLY the same body, skip lists, anon list
//  B  vendor-flow.js: states, product checks, totals, studio clock, offer comparison; the preview = the e-mail that is sent
//  C  vendor-request.mjs: product list, no money + no title in the request, the new kinds, HTML, fails closed, old rows unchanged
//  D  the vendor's page: both servers, no HTML strings, keys, currency, GST only in India
//  E  wiring: store-api fallback, Vendors page, Resource plan, Inventory, Wrap-up, Budget, event card, Automations
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { vendorRequestMessage, vendorRequestHtml, vendorFlowMessage, vendorFlowHtml, products } from '../supabase/functions/comms-dispatch/vendor-request.mjs';
import { billMoney } from '../supabase/functions/comms-dispatch/vendor-bill-reminder.mjs';
const read = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
let n = 0, bad = 0; const t = async (name, fn) => { n++; try { await fn(); console.log('  ok ' + name); } catch (e) { bad++; console.log('  FAIL ' + name + '\n' + ((e && e.stack) || e)); } };
const SQL = read('supabase/migrations/0447_r259_vendor_flow.sql'), VF = read('public/vendor-flow.js'), VR = read('public/vendor-request.js'), VRH = read('public/vendor-request.html'), UI = read('public/vendor-requests-ui.js'), SA = read('public/store-api.js'), RES = read('public/resources.html'),
  EW = read('public/event-wrap.js'), SV = read('public/stock-vendor.js'), BUD = read('public/budget.html'), CD = read('supabase/functions/comms-dispatch/index.ts');
const P = (() => { const m = { exports: {} }; vm.runInNewContext(VF, { module: m, globalThis: {}, Intl, Date, Number, String, Math, JSON, Object, Array, isFinite, isNaN }); return m.exports._pure; })();
const J = (x) => JSON.parse(JSON.stringify(x));

await t('A 0447: no stored row changed or deleted, old bodies kept, every definer function pinned', () => {
  assert.match(SQL, /perform public\._r447_keep\(f\)/); assert.doesNotMatch(SQL, /\bdelete from\b|\btruncate\b|drop table|drop column|drop function/i);
  assert.match(SQL, /revoke all on table public\.vendor_offers from public/); assert.doesNotMatch(SQL, /create temp|set_config\(/i);
  for (const m of SQL.matchAll(/create or replace function public\.([a-z0-9_]+)\([\s\S]*?as \$/g)) assert.match(m[0], /set search_path = ''/, m[1]);
  for (const u of SQL.match(/^update public\.[a-z_]+/gm) || []) assert.fail('top-level update ' + u);
  assert.equal([...SQL].filter((c) => c.charCodeAt(0) > 126).length, 0, 'ASCII only');
});
await t('A links: cancelled + trial gates, rate limits, size cap, own request only; the old dispatcher never gets the new kinds', () => {
  for (const f of ['vendor_link_offer', 'vendor_offer_upload']) { const b = SQL.slice(SQL.indexOf('function public.' + f + '('), SQL.indexOf('end $$;', SQL.indexOf('function public.' + f + '('))); assert.match(b, /_r125_ref_closed\('vendor', p_token\)/); assert.match(b, /_a260_link_state\('vendor', p_token\)/); }
  assert.match(SQL, /rate_hit\('vendor_link_offer'/); assert.match(SQL, /octet_length\(p::text\) > 20000/); assert.match(SQL, /if o\.request_id <> r\.id then raise/);
  assert.equal((SQL.match(/kind in \('request', 'reminder'\)/g) || []).length >= 3, true); assert.match(SQL, /x\.kind in \('change', 'confirmed', 'invoice_ask', 'invoice_auto'\)/);
});
await t('A invoice e-mails: day after 10:00 studio time, +3, +7; stops; only requests confirmed after the file and before the first slot', () => {
  assert.match(SQL, /v_days integer\[\] := array\[1, 4, 8\]/); assert.match(SQL, /time '10:00'\) at time zone x\.tz/); assert.match(SQL, /y\.confirmed_at is not null and not y\.invoice_only/);
  assert.match(SQL, /if r\.confirmed_at >= \(\(x\.last_day \+ 1\)/); assert.match(SQL, /vendor_invoice_ask_enabled boolean not null default true/); assert.match(SQL, /and not coalesce\(q\.is_demo, false\)/);
});
await t('A MANIFEST, APPLY (same body, one transaction), run-all, release lists, anon lists, trial clean-up', () => {
  assert.match(read('supabase/migrations/MANIFEST'), /\nforward  supabase\/migrations\/0447_r259_vendor_flow\.sql\n/);
  const ap = read('supabase/APPLY-0447.sql'); assert.ok(ap.includes(SQL)); assert.match(ap, /begin;\nset local lock_timeout = '5s';/); assert.ok(ap.trimEnd().endsWith('commit;'));
  const run = read('scripts/db-test/run-all.sh'); for (const x of ['r259-vendor-flow-0447', 'r259-vendor-race-0447', 'APPLY-0447']) assert.ok(run.includes(x), x);
  for (const r of ['1019', '1020']) assert.match(read('test/release-' + r + '.test.mjs'), /'0447'/);
  assert.match(SA, /vendor_link_offer\|vendor_link_respond\|vendor_offer_upload/); assert.match(read('tests/db/b-auth-invariants-0391.sql'), /'vendor_link_offer\(text, jsonb\)', 'vendor_offer_upload\(text, text\)'/);
  assert.match(read('tests/db/trial-retention-0184.sql'), /0447_r259_vendor_flow/); assert.match(SQL, /'''vendor_offers'', ''vendor_invoice_grants'', '/);
});

await t('B states: the server\'s word, and an older server from its status', () => {
  assert.equal(P.info({ flow: 447, state: 'available' }).step, 1); assert.equal(P.info({ state: 'paid' }).text, 'Paid and closed'); assert.equal(P.info({ state: 'declined', declined_by: 'studio' }).text, 'You declined their offer');
  assert.equal(P.info({ status: 'sent' }).k, 'asked'); assert.equal(P.info({ status: 'accepted', invoices_open: 1 }).k, 'invoice_received'); assert.equal(P.info({ status: 'accepted', invoices_approved: 1, invoices: [{ status: 'approved', pay_status: 'paid' }] }).k, 'paid');
  assert.equal(P.info({ status: 'cancelled' }).k, 'closed'); assert.equal(P.info(null).text, 'Not asked'); assert.deepEqual(J(P.STEPS), ['Asked', 'Available', 'Confirmed', 'Invoice asked', 'Invoice received', 'Approved', 'Paid', 'Closed']);
});
await t('B products: names, quantities, optional prices, 30 at most; the total only when every price is known', () => {
  assert.equal(P.checkLines([]).error, 'Add a product.'); assert.equal(P.checkLines([{ name: '<b>', qty: 1 }]).field, 'name'); assert.equal(P.checkLines([{ name: 'A', qty: '0' }]).field, 'qty'); assert.equal(P.checkLines([{ name: 'A', qty: '1', price: '1.234' }]).field, 'price'); assert.equal(P.checkLines([{ name: 'A', qty: '-1' }]).field, 'qty');
  assert.match(P.checkLines(Array(31).fill({ name: 'A', qty: 1 })).error, /30/);
  const v = P.checkLines([{ name: '  White   chairs ', qty: '1,200', price: '12.5', need_id: 'x' }, { name: 'Tent', qty: '1', price: '' }]); assert.deepEqual(J(v.lines), [{ name: 'White chairs', qty: 1200, price: 12.5, need_id: 'x' }, { name: 'Tent', qty: 1, price: null }]);
  assert.equal(P.total(v.lines), null); assert.equal(P.total([{ qty: 3, price: 33.33 }, { qty: 1, price: 0.01 }]), 100); assert.ok(Number.isNaN(P.amount('12a'))); assert.equal(P.amount(''), null); assert.equal(P.amount('1,250.50'), 1250.5);
});
await t('B the offer against what was asked', () => {
  const c = P.compare({ lines: [{ name: 'Chairs', asked_qty: 12, qty: 8, asked_price: 50, price: 60, total: 480 }, { name: 'Tent', asked_qty: 1, qty: 1, asked_price: null, price: 9 }] });
  assert.equal(c[0].lessQty, true); assert.equal(c[0].otherPrice, true); assert.equal(c[1].lessQty, false); assert.equal(c[1].otherPrice, false); assert.equal(c[1].total, 9);
});
await t('B the studio\'s clock', () => { assert.equal(P.zoned('2026-12-20', '10:00', 'Asia/Kolkata'), '2026-12-20T04:30:00.000Z'); assert.equal(P.zoned('2026-12-20', '10:00', 'America/Toronto'), '2026-12-20T15:00:00.000Z'); assert.equal(P.zoned('', '10:00', 'Asia/Kolkata'), null); });
const ROW = { channel: 'email', vendor_name: 'Deccan', what: 'Chairs, Tables', when_text: '20/12/2026, 10:00 AM', respond_by_text: '18/12/2026, 06:00 PM', event: 'Wedding', event_date: '20/12/2026', studio: 'Aurora Events', token: 'ab'.repeat(32), flow: 447, currency: 'INR',
  lines: [{ name: 'Chairs', qty: 1200, unit: 'pcs' }, { name: 'Tables', qty: 4 }], confirmed: { lines: [{ name: 'Chairs', qty: 1200, unit: 'pcs', price: 50 }, { name: 'Tables', qty: 4, price: 250.5 }], charges: 500, discount: 100, total: 61402 } };
const O = 'https://www.helm.events';
await t('B the preview shows exactly the e-mail that is sent (INR and AED, with and without prices)', () => {
  for (const cur of ['INR', 'AED']) for (const c of [ROW.confirmed, { lines: ROW.lines, total: null }, null]) {
    const row = { ...ROW, kind: 'invoice_ask', currency: cur, confirmed: c }, m = vendorFlowMessage(row, O), a = P.askMail({ vendor_name: row.vendor_name, studio: row.studio, event: row.event, event_date: row.event_date, currency: cur, confirmed: c, what: row.what });
    assert.equal(a.subject, m.subject); assert.equal(a.text.replace('{link}', O + '/vendor-request?t=' + row.token), m.text);
  }
  assert.equal(P.mailMoney(1250.5, 'AED'), billMoney(1250.5, 'AED'));
});

await t('C the request e-mail: the products, no money, one link; an older database row reads as before', () => {
  const m = vendorRequestMessage({ ...ROW, kind: 'request' }, O); assert.match(m.text, /- Chairs: 1,200 pcs\n- Tables: 4/); assert.doesNotMatch(m.text + m.subject, /Rs|50\b|61/); assert.equal((m.text.match(/https:/g) || []).length, 1); assert.match(m.subject, /2 products for Wedding/);
  assert.match(vendorRequestMessage({ ...ROW, kind: 'request', price_open: true }, O).text, /tell us your price/);
  const old = { ...ROW, kind: 'request' }; delete old.flow; assert.match(vendorRequestMessage(old, O).text, /then Accept or Decline/); assert.equal(vendorRequestHtml(old, O), '');
  const h = vendorRequestHtml({ ...ROW, kind: 'request', studio: '<b>x</b>' }, O); assert.match(h, /&lt;b&gt;|x/); assert.doesNotMatch(h, /<b>x/); assert.match(h, /Answer the request/); assert.match(h, /Chairs/);
});
await t('C change / confirmed / invoice: words, product table with prices, big button; anything odd = nothing is sent', () => {
  const ch = vendorFlowMessage({ ...ROW, kind: 'change', message: 'Please do 45 each' }, O); assert.match(ch.text, /"Please do 45 each"/); assert.match(ch.subject, /change your offer/);
  assert.equal(vendorFlowMessage({ ...ROW, kind: 'change' }, O).text, ''); assert.match(vendorFlowMessage({ ...ROW, kind: 'confirmed' }, O).text, /Agreed total: Rs 61,402/);
  for (const k of ['invoice_ask', 'invoice_auto']) { const m = vendorFlowMessage({ ...ROW, kind: k }, O); assert.match(m.subject, /^Please send your invoice/); assert.match(m.text, /Chairs: 1,200 pcs x Rs 50 = Rs 60,000/); const h = vendorFlowHtml({ ...ROW, kind: k }, O); assert.match(h, /Send your invoice/); assert.match(h, /Agreed total/); }
  for (const r of [{ ...ROW, kind: 'request' }, { ...ROW, kind: 'x' }, { ...ROW, kind: 'invoice_ask', token: 'no' }, { ...ROW, kind: 'invoice_ask', channel: 'whatsapp' }, { ...ROW, kind: 'invoice_ask', what: '' }, null]) { assert.equal(vendorFlowMessage(r, O).text, ''); assert.equal(vendorFlowHtml(r, O), ''); }
  assert.equal(vendorFlowMessage({ ...ROW, kind: 'invoice_ask' }, 'javascript:x').text, ''); assert.equal(products([{ name: 'a', qty: 0 }, { qty: 2 }, null, { name: 'ok', qty: 2, price: -1 }]).length, 1);
  for (const x of ['change', 'confirmed', 'invoice_auto']) assert.doesNotMatch(vendorFlowHtml({ ...ROW, kind: x, message: '<img src=x>', vendor_name: '<script>' }, O), /<script|<img src=x/);
});
await t('C comms-dispatch: its own claim, a database without 0447 has nothing to claim, the same mark, the studio\'s reply-to', () => {
  assert.match(CD, /admin\.rpc\("vendor_flow_claim", \{ p_limit: batch \}\)/); assert.match(CD, /vfErr && !\/PGRST202\|42883\/\.test/); assert.match(CD, /vendorRequestHtml\(r, origin, \{ address: postalAddress\(env\) \}\) \|\| undefined/);
});

await t('D the vendor\'s page: one form per step, no HTML strings, both servers, a key per answer, the currency of the event, GST only in India', () => {
  assert.doesNotMatch(VR, /innerHTML|insertAdjacentHTML|outerHTML|\.style\b/); assert.match(VR, /Number\(cur\.flow\) === 447/); assert.match(VR, /rpc\("vendor_link_respond"/); assert.match(VR, /rpc\("vendor_link_offer"/); assert.match(VR, /"vendor_offer_upload"/);
  assert.match(VR, /body\.key = keyFor\(/); assert.match(VR, /cur\.gst !== false/); assert.match(VRH, /id="vo-one"/); assert.match(VRH, /Enter your price for each product/); assert.doesNotMatch(VRH, /₹/);
  assert.match(VR, /var r2|function r2/); assert.match(VR, /iso = cur\.today/);
  for (const m of VRH.matchAll(/<input[^>]*id="([^"]+)"/g)) assert.ok(VRH.includes('for="' + m[1] + '"') , 'label for ' + m[1]);
});
await t('E store-api: ask falls back to the older request; the preview is null without 0447', async () => {
  const src = SA.slice(SA.indexOf('    async ask(row) {'), SA.indexOf('    // action: approve | change | decline'));
  const calls = []; const ctx = { supa: 1, vrNeed: () => 0, rpcMissing: (e) => e.code === 'PGRST202', rpc: (f, a) => { calls.push([f, a.p]); return f === 'vendor_request_ask' ? Promise.reject({ code: 'PGRST202' }) : Promise.resolve({ ok: 1 }); }, Math, Number, Error };
  vm.createContext(ctx); vm.runInContext('this.o = {' + src + '};', ctx);
  await ctx.o.ask({ quote_id: 'q', vendor_id: 'v', lines: [{ name: 'Chairs', qty: 2, price: 10.5 }, { name: 'Tent', qty: 1, price: 100 }], when_at: 'x' });
  assert.equal(calls[1][0], 'vendor_request_save'); assert.equal(calls[1][1].agreed_amount, 121); assert.equal(calls[1][1].what, 'Chairs x2, Tent x1'); assert.equal(calls[1][1].lines, undefined);
  await assert.rejects(ctx.o.ask({ lines: [{ name: 'A', qty: 1, price: null }] }), /agreed total/i);
});
await t('E pages: Vendors (prices to approve, ask for the invoice), Resource plan, Inventory, Wrap-up, Budget, event card, Automations', () => {
  const VH = read('public/vendors.html'); assert.match(VH, /data-f="offers"/); for (const h of [VH, RES, BUD]) assert.match(h, /vendor-flow\.js\?v=/); assert.match(UI, /F\(\)\.offerBox\(r, \{ canAssign: state\.canAssign, reload: load \}\)/); assert.match(UI, /F\(\)\.askInvoice\(\{ requestId: r\.id/); assert.doesNotMatch(UI, /event_title \|\| "our event"/);
  assert.match(RES, /BPStore\.vendorRequests\.ask\(/); assert.match(RES, /lineQty\(c\)/); assert.match(SV, /lockVendor: true, bookingId: res\.bookingId/); assert.match(EW, /F\.askInvoice\(\{ requestId: i\.id \|\| null, bookingId: i\.id \? null : r\.id/);
  assert.match(BUD, /HelmVendorFlow\.budget\(\$\("#vendorFlowCard"\),id\)/); assert.match(read('public/event.html'), /offers_to_review/); assert.match(read('public/automations.js'), /key: "vendor_invoice_ask"/);
  assert.doesNotMatch(VF, /innerHTML|insertAdjacentHTML|\.style\b/); assert.match(read('package.json'), /node test\/r259-vendor-flow\.test\.mjs/);
});
await t('E vendor-flow: nothing is sent without a button; approve asks first; keys for the same press twice; the database decides', () => {
  assert.match(VF, /Approve the price of /); assert.match(VF, /p\.key = key/); assert.match(VF, /\(their private link\)/); assert.match(VF, /Only make a link/); assert.match(VF, /e\.key === "Escape"/);
});
console.log('r259-vendor-flow: ' + (n - bad) + '/' + n + ' passed'); if (bad) process.exit(1);
