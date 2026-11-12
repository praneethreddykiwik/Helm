// r158-quotes-continue-sh.test.mjs - R158 (P1 found by the 12 Nov staging E2E): on the Quotes list every editor render
// crashed with "ReferenceError: sh is not defined" because R154c's continueOf() (outer scope) called sh(), which is a
// local helper inside render(). The crash happened inside the row-wiring loop, so no row button (Edit, Continue, the
// "..." menu) worked. Fix: continueOf reads shelf.byId directly. This test runs continueOf in a sandbox WITHOUT sh.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const html = readFileSync(new URL('../public/quotes.html', import.meta.url), 'utf8');
let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

const start = html.indexOf('const continueOf=(x)=>{');
assert.ok(start > 0, 'continueOf found');
const end = html.indexOf('\n  };', start);
const src = html.slice(start, end + 5);

ok('continueOf never calls the render-local sh()', () => {
  assert.ok(!/\bsh\(/.test(src), 'continueOf must not call sh()');
});

ok('continueOf runs without a ReferenceError (no sh in scope)', () => {
  const H = { isOpen: () => true, phaseOf: () => 'building', href: () => 'flow.html', stepNo: () => 1, LABELS: {}, stepText: () => 'Client' };
  const ctx = { window: { HelmFlowResume: H }, canEdit: true, ip: { canEdit: true, byId: {}, ready: false }, shelf: { byId: { a: { shelf: 'archived' } } }, encodeURIComponent };
  vm.createContext(ctx);
  vm.runInContext(src + '\nthis.continueOf = continueOf;', ctx);
  const open = ctx.continueOf({ id: 'q1' });
  assert.ok(open && /flow\.html\?quote=q1/.test(open.href), 'open quote gets Continue');
  assert.equal(ctx.continueOf({ id: 'a' }), null, 'archived / deleted (shelf) quote gets no Continue');
});

console.log(`r158-quotes-continue-sh: ${pass} passed`);
