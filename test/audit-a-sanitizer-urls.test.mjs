#!/usr/bin/env node
// audit-a-sanitizer-urls.test.mjs - audit 2026-11-18 (agent A, web attacks).
// The Trusted Types default-policy sanitizer (public/trusted-types.js) must never keep a link or image URL that
// leaves Helm while looking relative: "//evil", "/\evil", "\\evil", "\/evil" (browsers read "\" as "/" in http(s)
// URLs). Runs the file's own urlOk() against the payloads; READ-ONLY, no network.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TT = readFileSync(join(ROOT, 'public/trusted-types.js'), 'utf8');
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name); };

const pick = (re, what) => { const m = TT.match(re); assert.ok(m, what + ' must exist in trusted-types.js'); return m[0]; };
const src = [
  pick(/var SAFE_URL = .*;/, 'SAFE_URL'),
  pick(/var SAFE_DATA_IMG = .*;/, 'SAFE_DATA_IMG'),
  pick(/function urlOk\(name, v\) \{[\s\S]*?\n  \}/, 'urlOk'),
].join('\n');
const urlOk = new Function(src + '\nreturn urlOk;')();

t('protocol-relative and backslash URLs are refused (they leave Helm)', () => {
  for (const bad of ['//evil.example/x', '/\\evil.example', '\\\\evil.example', '\\/evil.example', ' //evil.example', '/\t/evil.example', '/\n\\evil.example'])
    for (const attr of ['href', 'src', 'srcset', 'poster'])
      assert.equal(urlOk(attr, bad), false, attr + ' must refuse ' + JSON.stringify(bad));
});

t('script-ish schemes stay refused', () => {
  for (const bad of ['javascript:alert(1)', ' javascript:alert(1)', 'java\tscript:alert(1)', 'vbscript:x', 'data:text/html,<script>alert(1)</script>'])
    assert.equal(urlOk('href', bad), false, JSON.stringify(bad));
});

t('normal Helm URLs still pass', () => {
  for (const ok of ['/dashboard', '/studio-a/quotes', 'quotes.html?id=1', '#top', '?tab=2', 'https://www.helm.events/x', 'mailto:a@b.test', 'tel:+919876543210', 'blob:https://www.helm.events/abc'])
    assert.equal(urlOk('href', ok), true, JSON.stringify(ok));
  assert.equal(urlOk('src', 'data:image/png;base64,iVBORw0KGgo='), true);
});

t('every page loads the same (bumped) trusted-types.js version', () => {
  const vs = new Set();
  for (const f of readdirSync(join(ROOT, 'public')).filter((x) => x.endsWith('.html'))) {
    for (const m of readFileSync(join(ROOT, 'public', f), 'utf8').matchAll(/trusted-types\.js\?v=(\d+)/g)) vs.add(m[1]);
  }
  assert.deepEqual([...vs], ['9']);
});

console.log(`audit-a-sanitizer-urls: ${n} passed`);
