// F-audit (18 Nov 2026): on a phone the studio filled City / State / PIN / Business phone /
// Primary location, yet every one still showed "X is required". Cause: the studio-setup
// business-details step (onboarding.js) never cleared a field's error once it was filled - the
// errors from the first "Save & continue" stayed on screen until the next save. Settings > General
// cleared on input/change only (an autofill that fires neither left the error up).
// Also: "Primary location / city" now follows City (auto-filled; a different one only behind the
// "Different city shown to clients?" link); a different SAVED value is shown and kept as it is.
// Pure helpers run in Node; the real onboarding.js + control.html markup run in headless Chromium
// with a stub store when Playwright is installed (skipped, not failed, otherwise).
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const OB = require('../public/onboarding-core.js');
const tests = []; const t = (n, f) => tests.push([n, f]); let n = 0;

const good = { country: 'IN', legal_name: 'Lakshmi Décor', line1: '12 Road No 3', city: 'Hyderabad', state: 'Telangana', pin: '500034', phone: '+91 98765 43210' };

t('location follows City: an empty location is filled from City and is not "required"', () => {
  const r = OB.validateBilling(Object.assign({}, good, { location: '' }));
  assert.equal(r.ok, true, JSON.stringify(r.errors)); assert.equal(r.data.location, 'Hyderabad');
  assert.equal(OB.billingPatch({ name: 'X', brand: {} }, r.data).location, 'Hyderabad');
  // no City -> both still required (nothing invented)
  const e = OB.validateBilling(Object.assign({}, good, { city: '', location: '' })).errors;
  assert.ok(e.city && e.location);
});
t('a different saved location is kept as it is (never overwritten by City)', () => {
  const r = OB.validateBilling(Object.assign({}, good, { location: 'Secunderabad' }));
  assert.equal(r.data.location, 'Secunderabad');
  assert.equal(OB.locationLinked('', 'Hyderabad'), true);
  assert.equal(OB.locationLinked(' hyderabad ', 'Hyderabad'), true);
  assert.equal(OB.locationLinked('Hyderabad, India', 'Hyderabad'), false);
  assert.equal(OB.locationLinked('Secunderabad', 'Hyderabad'), false);
  assert.equal(OB.locationLinked('बेंगलुरु', 'बेंगलुरु'), true, 'non-Latin city names compare too');
});
t('source: onboarding clears a field error on input/change/focusout; control.html has the link', () => {
  const js = read('public/onboarding.js'), cc = read('public/control.html');
  assert.match(js, /function syncBillField\(t\)/);
  assert.match(js, /if \(syncBillField\(ev\.target\)\) return;[\s\S]*if \(syncBillField\(ev\.target\)\) return;/);
  assert.match(js, /addEventListener\("focusout"/);
  assert.match(js, /Different city shown to clients\?/);
  assert.match(cc, /id="o_locown"[^>]*hidden>Different city shown to clients\?<\/button>/);
  assert.match(cc, /id="o_location_fld"/);
  assert.match(read('public/studio-billing-form.js'), /el\.addEventListener\("blur"/);
});

// ---- headless Chromium ---------------------------------------------------------------------------
function serve(pages) {
  const dir = path.resolve(new URL('public/', root).pathname);
  return http.createServer((q, r) => {
    const u = decodeURIComponent(new URL(q.url, 'http://x').pathname);
    if (pages[u]) { r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return r.end(pages[u]); }
    const f = path.join(dir, u); if (!f.startsWith(dir)) { r.writeHead(403); return r.end(); }
    try { const b = readFileSync(f); r.writeHead(200, { 'content-type': /\.css$/.test(f) ? 'text/css' : 'application/javascript' }); r.end(b); } catch (e) { r.writeHead(404); r.end(); }
  }).listen(0);
}
// a stub store: an admin whose studio has no billing details yet
const STUB = `<script>
window.__saved = [];
window.BPUI = { boot: (f) => f(), toast: () => {}, guard: async (b, f) => f(), friendlyError: (e) => String(e && e.message || e), confirm: async () => true };
const org = { id: 'o1', name: 'Lakshmi Décor', brand: {}, location: null };
window.BPStore = { init: async () => {}, mode: () => 'supabase',
  auth: { enabled: () => true, required: () => true, user: () => ({ id: 'u1' }), role: async () => 'admin', canEditArea: async () => true, admin: { roles: () => [], roleLabel: (r) => r } },
  trialOrg: { inTrial: async () => false },
  org: { current: async () => org, save: async (p) => { window.__saved.push(p); } },
  config: { getPricing: async () => ({}), setPricing: async () => {} },
  tax: { countries: () => [{ iso: 'IN', name: 'India' }], code: (c) => c || 'IN', profile: () => ({ known: true, currency: 'INR' }) },
  countries: () => [], menuTemplates: { list: async () => [] }, templates: { list: async () => [] } };
</script>`;

async function browser() {
  let pw = null; try { pw = await import('playwright'); } catch (e) {}
  if (!pw) { console.log('  - headless checks skipped (playwright not installed)'); return; }
  const CTL = read('public/control.html');
  const card = CTL.slice(CTL.indexOf('<h3>Organization / studio</h3>'), CTL.indexOf('<div class="s-e3ae377" id="slugBox"'));
  const onb = `<!doctype html><html><head><meta charset="utf-8"><style>[hidden]{display:none!important}</style></head><body>
<div id="boot"></div><div id="app" hidden><div id="obLive" role="status"></div><div id="obRoot"></div></div><div id="obPark"></div>${STUB}
<script src="/country-profile.js"></script><script src="/onboarding-core.js"></script><script src="/onboarding-wizard.js"></script><script src="/onboarding.js"></script></body></html>`;
  const ctl = `<!doctype html><html><head><meta charset="utf-8"><style>[hidden]{display:none!important}</style></head><body><div class="card">${card}</div>
<script src="/phone-input.js"></script><script src="/country-profile.js"></script><script src="/onboarding-core.js"></script><script src="/studio-billing-form.js"></script></body></html>`;
  const srv = serve({ '/onb.html': onb, '/ctl.html': ctl });
  let br; try { br = await pw.chromium.launch(); } catch (e) { srv.close(); console.log('  - headless checks skipped (no browser)'); return; }
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    // 1) studio setup, phone-sized screen: Save empty -> errors; fill -> every error goes; location follows City
    const pg = await br.newPage({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
    const errs = []; pg.on('pageerror', (e) => errs.push(String(e)));
    await pg.goto(base + '/onb.html#step-billing');
    await pg.waitForSelector('#obBill');
    assert.equal(await pg.isVisible('#ob_b_location'), false, 'location tucked away while it follows City');
    assert.equal(await pg.isVisible('#ob_b_locown'), true, '"Different city shown to clients?" link shown');
    await pg.click('[data-act="billsave"]');
    await pg.waitForFunction(() => /required/.test(document.getElementById('ob_b_city_err').textContent));
    // fill the way a phone does: typing for some, autofill-style value + change only for others
    await pg.fill('#ob_b_legal_name', 'Lakshmi Décor'); await pg.fill('#ob_b_line1', '12 Road No 3');
    await pg.fill('#ob_b_city', 'Hyderabad');
    await pg.evaluate(() => { for (const [id, v] of [['ob_b_state', 'Telangana'], ['ob_b_pin', '500034']]) { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); } });
    await pg.evaluate(() => { const el = document.getElementById('ob_b_phone'); el.focus(); el.value = '+91 98765 43210'; el.blur(); });   // no input/change at all
    const after = await pg.evaluate(() => ['legal_name', 'line1', 'city', 'state', 'pin', 'phone', 'location'].map((k) => [k, document.getElementById('ob_b_' + k + '_err').textContent, document.getElementById('ob_b_' + k).getAttribute('aria-invalid')]));
    for (const [k, msg, inv] of after) { assert.equal(msg, '', k + ' error must clear once filled'); assert.notEqual(inv, 'true', k + ' aria-invalid'); }
    assert.equal(await pg.inputValue('#ob_b_location'), 'Hyderabad', 'location follows City');
    await pg.click('[data-act="billsave"]');
    await pg.waitForFunction(() => window.__saved.length > 0);
    const saved = await pg.evaluate(() => window.__saved[0]);
    assert.equal(saved.location, 'Hyderabad'); assert.equal(saved.brand.billing.city, 'Hyderabad'); assert.equal(saved.brand.billing.pin, '500034');
    assert.equal(saved.brand.billing.legal_name, 'Lakshmi Décor', 'UTF-8 name kept');
    assert.deepEqual(errs, []);
    // 2) "Different city shown to clients?" opens the field; a typed one is saved as it is
    const p2 = await br.newPage({ viewport: { width: 320, height: 640 } });
    await p2.goto(base + '/onb.html#step-billing'); await p2.waitForSelector('#obBill');
    await p2.click('#ob_b_locown');
    assert.equal(await p2.isVisible('#ob_b_location'), true); assert.equal(await p2.evaluate(() => document.activeElement.id), 'ob_b_location');
    await p2.fill('#ob_b_location', 'Secunderabad'); await p2.fill('#ob_b_city', 'Hyderabad');
    assert.equal(await p2.inputValue('#ob_b_location'), 'Secunderabad', 'an own location is never overwritten by City');
    const sw = await p2.evaluate(() => document.documentElement.scrollWidth); assert.ok(sw <= 320, 'no sideways scroll at 320 px (' + sw + ')');
    console.log('  ✓ headless Chromium (375 px): studio setup errors clear once filled (typing, change-only and silent autofill); location follows City; own city kept');
    // 3) Settings > General: same rules on the control.html markup
    const p3 = await br.newPage({ viewport: { width: 375, height: 812 } });
    await p3.goto(base + '/ctl.html');
    const r = await p3.evaluate(() => {
      const BF = window.HelmBillingForm, $ = (s) => document.querySelector(s);
      // the control.html wiring for the link (copied from the page script by the source assert above)
      const OB = window.HelmOnboarding, out = {};
      const paint = (saved, city) => { const linked = OB.locationLinked(saved, city); if (linked) $('#o_location').value = city || ''; $('#o_location_fld').hidden = linked; $('#o_locown').hidden = !linked; };
      $('#o_location').value = 'Secunderabad'; $('#o_city').value = 'Hyderabad'; paint('Secunderabad', 'Hyderabad');
      out.keptShown = !$('#o_location_fld').hidden && $('#o_location').value === 'Secunderabad' && $('#o_locown').hidden;
      paint('', 'Hyderabad'); out.linkedHidden = $('#o_location_fld').hidden && $('#o_location').value === 'Hyderabad' && !$('#o_locown').hidden;
      const city = $('#o_city'); city.value = ''; BF.showErrors([{ el: city, msg: 'City is required.' }]);
      city.value = 'Hyderabad'; city.dispatchEvent(new Event('blur'));   // autofill that fired no input/change
      out.blurCleared = city.getAttribute('aria-invalid') !== 'true' && document.getElementById('o_city_ferr').hidden;
      const pin = $('#o_pin'); pin.value = '12'; BF.showErrors([{ el: pin, msg: 'PIN code must be 6 digits (not starting with 0).' }]);
      pin.dispatchEvent(new Event('blur')); out.unchangedKept = pin.getAttribute('aria-invalid') === 'true';
      return out; });
    assert.ok(r.keptShown, 'a different saved location is shown and kept'); assert.ok(r.linkedHidden, 'empty location follows City, link shown');
    assert.ok(r.blurCleared, 'leaving a field with a new value clears its error'); assert.ok(r.unchangedKept, 'an unchanged wrong value keeps its error');
    const src = CTL;
    assert.match(src, /function paintLocationLink\(saved, city\)\{[\s\S]*?OB\.locationLinked\(saved, city\)/);
    console.log('  ✓ headless Chromium: Settings > General keeps a saved city, links an empty one, blur clears a changed field');
  } finally { await br.close(); srv.close(); }
}

for (const [name, fn] of tests) { await fn(); n++; console.log('  ✓ ' + name); }
await browser();
console.log(`f-billing-stale-errors: ${n} passed`);
