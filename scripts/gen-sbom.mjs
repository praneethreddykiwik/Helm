#!/usr/bin/env node
/* gen-sbom.mjs - R147: a reproducible CycloneDX 1.6 SBOM (sbom.json) of what Helm ships.
 *
 *   node scripts/gen-sbom.mjs                       rewrite sbom.json
 *   node scripts/gen-sbom.mjs --check               exit 1 if sbom.json is stale (read-only, NO network)
 *   node scripts/gen-sbom.mjs --npm-bom <file>      also cross-check the npm part against a cyclonedx-npm output
 *
 * Everything is read from files in the repo (no network, no node_modules), so the same tree always gives the
 * same SBOM. Four groups of components (property "helm:group"):
 *   npm-runtime     package-lock.json, dev packages left out (= cyclonedx-npm --omit dev). @supabase/supabase-js
 *                   is the one runtime dependency (server.js / scripts); scope "required".
 *   build-tool      tools/build/package-lock.json (terser + clean-css for scripts/build-dist.mjs). Used to build
 *                   dist/, never served; scope "excluded".
 *   vendored-browser public/vendor/* - the third-party files browsers actually download (supabase-js UMD, the
 *                   Sentry browser bundle, three.js). Version from the file / folder name, checked against
 *                   public/vendor/README.md; SHA-384 of the served bytes. scope "required".
 *   deno-edge       imports of supabase/functions/** (npm:@supabase/supabase-js@x, scope "required") and the
 *                   test-only Deno modules (jsr:@std/assert + its jsr deps from deno.lock, https://deno.land/std
 *                   used by tests/edge); test-only ones are scope "excluded".
 *
 * Cross-check used when R147 regenerated the file:
 *   (scratch copy of package.json + package-lock.json) npm ci --omit dev --ignore-scripts
 *   npx --yes @cyclonedx/cyclonedx-npm@6.0.1 --omit dev --output-format JSON --output-file npm-bom.json
 *   node scripts/gen-sbom.mjs --check --npm-bom <scratch>/npm-bom.json      -> same 9 npm components
 * Not wired into CI on purpose: the cross-check needs the registry. --check alone is offline and safe to wire.
 * metadata.timestamp and serialNumber are kept when the components did not change, so --check is stable.
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'sbom.json');
const args = process.argv.slice(2);
const CHECK = args.includes('--check');
const NPM_BOM = args.includes('--npm-bom') ? args[args.indexOf('--npm-bom') + 1] : null;
const rd = (p) => readFileSync(join(ROOT, p), 'utf8');
const sha384 = (abs) => createHash('sha384').update(readFileSync(abs)).digest('hex');
const problems = [];

const purlNpm = (name, version) => 'pkg:npm/' + name.replace(/^@/, '%40') + '@' + version;
const splitName = (full) => { const m = /^(@[^/]+)\/(.+)$/.exec(full); return m ? { group: m[1], name: m[2] } : { name: full }; };
const prop = (name, value) => ({ name, value: String(value) });

/* ---- npm lockfiles ---- */
function fromLock(lockRel, group, scope, keepDev) {
  const lock = JSON.parse(rd(lockRel));
  const out = [];
  for (const [path, p] of Object.entries(lock.packages || {})) {
    if (!path || !path.includes('node_modules/')) continue;
    if (p.dev && !keepDev) continue;
    const full = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const c = { type: 'library', ...splitName(full), version: p.version, scope,
      'bom-ref': group + ':' + full + '@' + p.version, purl: purlNpm(full, p.version) };
    if (p.license) c.licenses = [{ license: { id: p.license } }];
    if (p.integrity) {
      const [alg, b64] = p.integrity.split('-');
      if (/^sha(256|384|512)$/.test(alg)) c.hashes = [{ alg: 'SHA-' + alg.slice(3), content: Buffer.from(b64, 'base64').toString('hex') }];
    }
    if (p.resolved) c.externalReferences = [{ type: 'distribution', url: p.resolved }];
    c.properties = [prop('helm:group', group), prop('helm:source', lockRel)];
    out.push(c);
  }
  return out;
}

/* ---- public/vendor ---- */
function vendored() {
  const dir = join(ROOT, 'public', 'vendor');
  const readme = existsSync(join(dir, 'README.md')) ? readFileSync(join(dir, 'README.md'), 'utf8') : '';
  const out = [];
  const known = [
    { re: /^supabase-js-(\d+\.\d+\.\d+)\.min\.js$/, pkg: '@supabase/supabase-js', lic: 'MIT', what: 'UMD build (window.supabase), loaded by store-api.js' },
    { re: /^sentry-(\d+\.\d+\.\d+)\.bundle\.min\.js$/, pkg: '@sentry/browser', lic: 'MIT', what: 'Sentry browser CDN bundle (errors only), loaded by telemetry.js' },
    { re: /^three-(\d+\.\d+\.\d+)$/, pkg: 'three', lic: 'MIT', what: 'three.js core + addons for the builder 3D view, loaded by three-boot.js' },
  ];
  for (const n of readdirSync(dir).sort()) {
    if (n === 'README.md') continue;
    const k = known.find((x) => x.re.test(n));
    if (!k) { problems.push(`public/vendor/${n}: unknown vendored file - add it to scripts/gen-sbom.mjs`); continue; }
    const version = k.re.exec(n)[1];
    if (!readme.includes(version)) problems.push(`public/vendor/${n}: version ${version} is not named in public/vendor/README.md`);
    const abs = join(dir, n);
    const files = statSync(abs).isDirectory() ? walk(abs) : [abs];
    const c = { type: 'library', ...splitName(k.pkg), version, scope: 'required', 'bom-ref': 'vendored-browser:' + n,
      purl: purlNpm(k.pkg, version), description: k.what, licenses: [{ license: { id: k.lic } }] };
    if (files.length === 1) c.hashes = [{ alg: 'SHA-384', content: sha384(files[0]) }];
    c.properties = [prop('helm:group', 'vendored-browser'),
      ...files.map((f) => prop('helm:file', relative(ROOT, f).split('\\').join('/') + (files.length > 1 ? ' sha384:' + sha384(f) : '')))];
    out.push(c);
  }
  return out;
}
function walk(d, acc = []) {
  for (const n of readdirSync(d).sort()) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p, acc); else acc.push(p); }
  return acc;
}

/* ---- Deno (edge functions + edge tests) ---- */
function deno() {
  const out = [];
  const scan = (rel) => existsSync(join(ROOT, rel)) ? walk(join(ROOT, rel)).filter((f) => /\.(ts|js|mjs)$/.test(f)) : [];
  const fnFiles = scan('supabase/functions'), testFiles = scan('tests/edge');
  const isTest = (f) => /(^|[\\/_])[^\\/]*_test\.ts$|\.test\.ts$/.test(f);
  const npmProd = new Map(), npmTest = new Map(), jsr = new Map(), remote = new Map();
  for (const f of [...fnFiles, ...testFiles]) {
    const src = readFileSync(f, 'utf8'), test = isTest(f) || testFiles.includes(f);
    for (const m of src.matchAll(/["'](npm|jsr):(@?[^@"'\s]+)@([^"'\/\s]+)[^"']*["']/g)) {
      const map = m[1] === 'jsr' ? jsr : (test ? npmTest : npmProd);
      const key = m[2] + '@' + m[3]; const prev = map.get(key);
      map.set(key, { name: m[2], version: m[3], test: prev ? prev.test && test : test });
    }
    for (const m of src.matchAll(/["']https:\/\/deno\.land\/std@([\d.]+)\/[^"']*["']/g)) remote.set(m[1], { version: m[1], test });
  }
  for (const [k, v] of npmProd) {
    out.push({ type: 'library', ...splitName(v.name), version: v.version, scope: 'required', 'bom-ref': 'deno-edge:npm:' + k,
      purl: purlNpm(v.name, v.version), properties: [prop('helm:group', 'deno-edge'), prop('helm:import', 'npm:' + k)] });
  }
  for (const [k, v] of npmTest) if (!npmProd.has(k)) {
    out.push({ type: 'library', ...splitName(v.name), version: v.version, scope: 'excluded', 'bom-ref': 'deno-edge:npm-test:' + k,
      purl: purlNpm(v.name, v.version), properties: [prop('helm:group', 'deno-edge'), prop('helm:import', 'npm:' + k), prop('helm:use', 'test-only')] });
  }
  // jsr: the exact versions resolved in deno.lock (+ their jsr dependencies); all test-only today
  const lock = existsSync(join(ROOT, 'deno.lock')) ? JSON.parse(rd('deno.lock')) : {};
  const jsrLock = lock.jsr || {};
  const seen = new Set();
  const addJsr = (nameAtVer, viaTest, via) => {
    if (seen.has(nameAtVer)) return; seen.add(nameAtVer);
    const at = nameAtVer.lastIndexOf('@'), name = nameAtVer.slice(0, at), version = nameAtVer.slice(at + 1);
    const ent = jsrLock[nameAtVer];
    if (!ent) problems.push(`deno.lock has no jsr entry for ${nameAtVer}`);
    const c = { type: 'library', ...splitName(name), version, scope: viaTest ? 'excluded' : 'required', 'bom-ref': 'deno-edge:jsr:' + nameAtVer,
      purl: 'pkg:generic/jsr/' + name.replace(/^@/, '%40') + '@' + version };
    if (ent && ent.integrity) c.hashes = [{ alg: 'SHA-256', content: ent.integrity }];
    c.properties = [prop('helm:group', 'deno-edge'), prop('helm:import', via || 'jsr:' + nameAtVer)].concat(viaTest ? [prop('helm:use', 'test-only')] : []);
    out.push(c);
    for (const d of (ent && ent.dependencies) || []) {
      const spec = d.replace(/^jsr:/, ''), dn = spec.replace(/(.)@[^@]*$/, '$1');
      const resolved = resolveJsr(dn, spec === dn ? '' : spec.slice(dn.length + 1));
      if (resolved) addJsr(dn + '@' + resolved, viaTest, 'jsr (dependency of ' + nameAtVer + ')');
      else problems.push(`deno.lock: cannot resolve ${d} (dependency of ${nameAtVer})`);
    }
  };
  // a spec such as jsr:@std/assert@1 -> the exact version deno.lock resolved it to
  const resolveJsr = (name, range) => {
    const sp = lock.specifiers || {};
    if (jsrLock[name + '@' + range]) return range;
    if (sp['jsr:' + name + '@' + range]) return sp['jsr:' + name + '@' + range];
    const hit = Object.keys(sp).find((k) => k.startsWith('jsr:' + name + '@')); return hit ? sp[hit] : range;
  };
  const jsrMerged = new Map();
  for (const v of jsr.values()) { const k = v.name + '@' + resolveJsr(v.name, v.version), p = jsrMerged.get(k); jsrMerged.set(k, { test: p ? p.test && v.test : v.test }); }
  for (const [k, v] of [...jsrMerged].sort()) addJsr(k, v.test);
  for (const [ver, v] of [...remote].sort()) {
    out.push({ type: 'library', name: 'std', group: 'deno.land', version: ver, scope: v.test ? 'excluded' : 'required',
      'bom-ref': 'deno-edge:https:deno.land/std@' + ver, purl: 'pkg:generic/deno.land/std@' + ver,
      externalReferences: [{ type: 'distribution', url: 'https://deno.land/std@' + ver + '/' }],
      properties: [prop('helm:group', 'deno-edge'), prop('helm:import', 'https://deno.land/std@' + ver)].concat(v.test ? [prop('helm:use', 'test-only')] : []) });
  }
  return out;
}

const pkg = JSON.parse(rd('package.json'));
const components = [
  ...fromLock('package-lock.json', 'npm-runtime', 'required', false),
  ...fromLock('tools/build/package-lock.json', 'build-tool', 'excluded', true),
  ...vendored(),
  ...deno(),
];
const byRef = (a, b) => (a['bom-ref'] < b['bom-ref'] ? -1 : a['bom-ref'] > b['bom-ref'] ? 1 : 0);
components.sort(byRef);

if (NPM_BOM) {   // optional cross-check against a cyclonedx-npm --omit dev output
  const ext = JSON.parse(readFileSync(NPM_BOM, 'utf8'));
  const key = (c) => (c.group ? c.group + '/' : '') + c.name + '@' + c.version;
  const mine = components.filter((c) => c.properties.some((p) => p.name === 'helm:group' && p.value === 'npm-runtime')).map(key).sort();
  const theirs = (ext.components || []).map(key).sort();
  if (JSON.stringify(mine) !== JSON.stringify(theirs)) problems.push(`npm part differs from ${NPM_BOM}:\n  ours   ${mine.join(' ')}\n  theirs ${theirs.join(' ')}`);
  else console.log(`  ✓ npm part matches cyclonedx-npm (${mine.length} components)`);
}

const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : null;
const body = {
  $schema: 'http://cyclonedx.org/schema/bom-1.6.schema.json', bomFormat: 'CycloneDX', specVersion: '1.6', version: 1,
  serialNumber: 'urn:uuid:00000000-0000-0000-0000-000000000000',
  metadata: {
    timestamp: '1970-01-01T00:00:00.000Z',
    tools: { components: [{ type: 'application', name: 'gen-sbom', group: 'helm', version: '1', description: 'scripts/gen-sbom.mjs (R147)' }] },
    component: { type: 'application', name: pkg.name, version: pkg.version, 'bom-ref': 'helm', description: pkg.description,
      licenses: [{ license: { name: pkg.license || 'UNLICENSED' } }] },
  },
  components,
  dependencies: [{ ref: 'helm', dependsOn: components.filter((c) => c.scope === 'required').map((c) => c['bom-ref']) }],
};
const stable = (b) => JSON.stringify({ ...b, serialNumber: null, metadata: { ...b.metadata, timestamp: null } });
const same = prev && stable(prev) === stable(body);
body.serialNumber = same ? prev.serialNumber : 'urn:uuid:' + randomUUID();
body.metadata.timestamp = same ? prev.metadata.timestamp : new Date().toISOString();
const text = JSON.stringify(body, null, 2) + '\n';

for (const p of problems) console.error('  ✗ ' + p);
if (CHECK) {
  if (!same) { console.error('  ✗ sbom.json is stale - run: node scripts/gen-sbom.mjs'); process.exit(1); }
  if (problems.length) process.exit(1);
  console.log(`  ✓ sbom.json is up to date (${components.length} components)`);
} else {
  if (problems.length) process.exit(1);
  if (!same || readFileSync(OUT, 'utf8') !== text) writeFileSync(OUT, text);
  const g = (n) => components.filter((c) => c.properties.some((p) => p.name === 'helm:group' && p.value === n)).length;
  console.log(`  ✓ sbom.json: ${components.length} components (npm-runtime ${g('npm-runtime')}, build-tool ${g('build-tool')}, vendored-browser ${g('vendored-browser')}, deno-edge ${g('deno-edge')})`);
}
