#!/usr/bin/env node
/* build-dist.mjs - R131 (owner, 9 Nov 2026: "shrink and scramble the code, remove comments and readable names ...
 * turn off source maps"). Vercel runs this (vercel.json buildCommand) and serves dist/ instead of public/.
 *
 *   public/  -> stays the readable source in git (tests, local server, reviews)
 *   dist/    -> what browsers download: every Helm .js minified with terser (comments removed, local names shortened,
 *              dead code dropped), every .css minified with clean-css. HTML is copied UNCHANGED, so the CSP script /
 *              style hashes in vercel.json + _headers stay valid. Third-party files under vendor/ (already minified,
 *              some pinned by integrity hashes) are copied as they are.
 *   Never a source map: no .map file is written or copied, and any "sourceMappingURL" comment is removed.
 *   Top-level names are KEPT (mangle.toplevel = false): Helm's pages are classic scripts that share globals
 *   (window.BPStore, HelmTaskReminders, ...), so only names inside functions are shortened.
 *   A file that cannot be parsed stops the build (exit 1) - a half-built site is never deployed.
 *
 *   node scripts/build-dist.mjs            build dist/
 *   node scripts/build-dist.mjs --check    build into a temp folder and report (CI); exit 1 on any problem
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { minify } from 'terser';
import CleanCSS from 'clean-css';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'public');
const CHECK = process.argv.includes('--check');
const OUT = CHECK ? mkdtempSync(join(tmpdir(), 'helm-dist-')) : join(ROOT, 'dist');
const SKIP_DIR = /(^|[\\/])vendor([\\/]|$)/;
const MAP_RE = /\n?\/[/*][#@] sourceMappingURL=[^\n]*\n?/g;

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

export const TERSER = {
  ecma: 2020,
  compress: { passes: 1, drop_debugger: true, pure_getters: false, keep_fargs: true },
  mangle: { toplevel: false, safari10: true },
  format: { comments: false, ascii_only: false },
  sourceMap: false,
  keep_classnames: true,
};

async function main() {
  if (!existsSync(SRC)) throw new Error('public/ missing');
  if (!CHECK) rmSync(OUT, { recursive: true, force: true });
  cpSync(SRC, OUT, { recursive: true, filter: (p) => !p.endsWith('.map') });
  let js = 0, css = 0, before = 0, after = 0;
  const problems = [];
  const css1 = new CleanCSS({ level: 1, returnPromise: false, inline: false, rebase: false });
  for (const f of walk(OUT)) {
    const rel = relative(OUT, f);
    if (SKIP_DIR.test(rel)) continue;
    if (f.endsWith('.js') || f.endsWith('.mjs')) {
      const src = readFileSync(f, 'utf8');
      let res = null;
      try { res = await minify(src, { ...TERSER, module: f.endsWith('.mjs') }); }
      catch (e) {
        try { res = await minify(src, { ...TERSER, module: true }); }   // an ES module loaded with type="module"
        catch (e2) { problems.push(rel + ': ' + (e && e.message)); continue; }
      }
      const code = String(res.code || '').replace(MAP_RE, '\n');
      if (!code.trim() && src.trim()) { problems.push(rel + ': empty output'); continue; }
      writeFileSync(f, code); js++; before += src.length; after += code.length;
    } else if (f.endsWith('.css')) {
      const src = readFileSync(f, 'utf8');
      const r = css1.minify(src);
      if (r.errors && r.errors.length) { problems.push(rel + ': ' + r.errors.join('; ')); continue; }
      const code = String(r.styles || '').replace(MAP_RE, '\n');
      writeFileSync(f, code); css++; before += src.length; after += code.length;
    }
  }
  // no source map anywhere in the output
  for (const f of walk(OUT)) {
    if (f.endsWith('.map')) problems.push(relative(OUT, f) + ': source map file');
    else if (/\.(js|mjs|css)$/.test(f) && !SKIP_DIR.test(relative(OUT, f)) && /sourceMappingURL=/.test(readFileSync(f, 'utf8'))) problems.push(relative(OUT, f) + ': sourceMappingURL left');
  }
  const pct = before ? Math.round((1 - after / before) * 100) : 0;
  console.log(`build-dist: ${js} JS + ${css} CSS files minified, ${(before / 1e6).toFixed(2)} MB -> ${(after / 1e6).toFixed(2)} MB (-${pct}%)${CHECK ? ' [check]' : ' -> dist/'}`);
  if (CHECK) rmSync(OUT, { recursive: true, force: true });
  if (problems.length) { console.error('build-dist: FAILED\n  ' + problems.join('\n  ')); process.exit(1); }
}
main().catch((e) => { console.error('build-dist: FAILED - ' + (e && e.stack || e)); process.exit(1); });
