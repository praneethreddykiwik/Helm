// r139-trusted-types-enforced.test.mjs - Trusted Types is ENFORCED on every page (R139).
// Static guards, READ-ONLY, no network. The behavioural proof was a logged-in Playwright sweep of every
// page (several roles, local server with the enforcing CSP) with zero Trusted Types violations.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const r = (p) => readFileSync(join(ROOT, p), 'utf8');
const require = createRequire(import.meta.url);
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name); };

const { TRUSTED_TYPES_ENFORCE, TT_DIRECTIVES, GIS_TT_POLICY, GIS_SCRIPT, withHashes } = require('../scripts/csp-hashes.cjs');
const TT = r('public/trusted-types.js');
const pages = readdirSync(join(ROOT, 'public')).filter((f) => f.endsWith('.html'));

t('enforcement flag is on and trusted-types.js sanitizes (enforce mode)', () => {
  assert.equal(TRUSTED_TYPES_ENFORCE, true);
  assert.match(TT, /var MODE = 'enforce';/);
  assert.match(TT, /return sanitize\(s\);/, 'default policy still runs the allowlist sanitizer');
  assert.match(TT, /createScript: function \(\) \{ return null; \}/, 'string-to-code stays refused');
});

t('every CSP in vercel.json and public/_headers enforces Trusted Types; no report-only leftover', () => {
  const v = JSON.parse(r('vercel.json'));
  let csp = 0;
  for (const rule of v.headers) for (const h of rule.headers) {
    if (h.key === 'Content-Security-Policy') { csp++; assert.match(h.value, /require-trusted-types-for 'script'/, rule.source); assert.match(h.value, /trusted-types helm default/, rule.source); }
    assert.notEqual(h.key, 'Content-Security-Policy-Report-Only', 'no report-only TT header once enforced');
  }
  assert.ok(csp > 5);
  for (const line of r('public/_headers').split('\n').filter((l) => /^\s*Content-Security-Policy:/.test(l)))
    assert.match(line, /require-trusted-types-for 'script'; trusted-types helm default/);
});

t("Google's goog#html policy name is allowed only where the page may load Google sign-in", () => {
  assert.equal(GIS_TT_POLICY, 'goog#html');
  const withGis = withHashes(`default-src 'self'; script-src 'self' ${GIS_SCRIPT}`, []);
  const without = withHashes("default-src 'self'; script-src 'self'", []);
  assert.match(withGis, /trusted-types helm default goog#html$/);
  assert.match(without, new RegExp(TT_DIRECTIVES[1] + '$'));
  assert.doesNotMatch(without, /goog#html/);
});

t('trusted-types.js is the first script that runs on every page', () => {
  // defer / module scripts run after every parser-blocking one, so only parser-blocking + async scripts count
  for (const f of pages) {
    const tags = [...r('public/' + f).matchAll(/<script\b[^>]*>/g)].map((m) => m[0])
      .filter((x) => !/type="application\/(ld\+)?json"/.test(x) && !/\sdefer\b/.test(x) && !/type="module"/.test(x));
    const i = tags.findIndex((x) => /src="\/trusted-types\.js\?v=\d+"/.test(x));
    assert.ok(i === 0 || (i === 1 && /trial-preview-frame\.js/.test(tags[0])), f + ': trusted-types.js must run before every other script');
  }
});

t('print pop-ups never document.write into about:blank (no policy there) - HelmPrintDoc builds them', () => {
  for (const f of ['public/quotes.html', 'public/flow.html']) {
    const s = r(f);
    assert.doesNotMatch(s, /w\.document\.write\(/, f);
    assert.match(s, /HelmPrintDoc\(w, html\)/, f);
  }
  assert.match(TT, /window\.HelmPrintDoc = function \(w, html\) \{\n    var d = w\.document;/);
  assert.match(TT, /if \(MODE === 'enforce'\) clean\(t\.content\);/, 'print body goes through the same sanitizer');
  assert.match(TT, /new w\.CSSStyleSheet\(\)/, 'print CSS through a constructable sheet');
});

t('manual keeps its CSS although the sanitizer drops <style> from DOMParser input', () => {
  const m = r('public/manual.js');
  assert.ok(m.indexOf('var css = (String(res.html).match(') < m.indexOf('new DOMParser().parseFromString(res.html'), 'CSS read before parsing');
});

t('allowlist covers the markup the app builds (datalist/list, passwordrules, svg version)', () => {
  for (const tag of ['datalist']) assert.match(TT, new RegExp('\\b' + tag + '\\b'));
  for (const a of ['list', 'passwordrules', 'version']) assert.match(TT, new RegExp(' ' + a + ' '));
});

console.log(`r139-trusted-types-enforced: ${n} checks passed`);
