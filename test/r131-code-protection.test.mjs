// r131: what browsers download is minified (no comments, short local names) and never has a source map.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
const r = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0;
const t = (name, fn) => { try { fn(); n++; console.log('  ok ' + name); } catch (e) { console.error('  FAIL ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; } };
const V = JSON.parse(r('vercel.json'));
const B = r('scripts/build-dist.mjs');
t('Vercel builds dist/ with the minify script only (still a static site)', () => {
  assert.equal(V.outputDirectory, 'dist'); assert.equal(V.buildCommand, 'node scripts/build-dist.mjs');
  assert.match(V.installCommand, /^npm ci --ignore-scripts/); assert.equal(V.framework, null);
  assert.ok(!('functions' in V) && !('builds' in V));
});
t('terser: comments removed, local names shortened, globals kept, no source map', () => {
  assert.match(B, /format: \{ comments: false/); assert.match(B, /mangle: \{ toplevel: false/); assert.match(B, /sourceMap: false/);
  assert.match(B, /filter: \(p\) => !p\.endsWith\('\.map'\)/); assert.match(B, /sourceMappingURL left/);
});
t('HTML is copied unchanged (CSP hashes stay valid); vendor files untouched', () => {
  assert.doesNotMatch(B, /\.html'\)/); assert.match(B, /SKIP_DIR = \/\(\^\|\[\\\\\/\]\)vendor/);
});
t('pinned exact build tools', () => {
  const p = JSON.parse(r('package.json'));
  assert.equal(p.devDependencies.terser, '5.51.2'); assert.equal(p.devDependencies['clean-css'], '5.3.3');
});
t('dist/ never committed; CI builds it on every PR', () => {
  assert.match(r('.gitignore'), /^dist\/$/m);
  const ci = r('.github/workflows/ci.yml');
  assert.match(ci, /npm ci --ignore-scripts --no-audit --no-fund/); assert.match(ci, /node scripts\/build-dist\.mjs --check/);
});
t('no source map file in public/', () => {
  const walk = (d) => readdirSync(new URL('../' + d, import.meta.url), { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(d + '/' + e.name) : [d + '/' + e.name]);
  assert.deepEqual(walk('public').filter((f) => f.endsWith('.map')), []);
});
console.log(`r131-code-protection: ${n} passed`);
