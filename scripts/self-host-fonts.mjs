#!/usr/bin/env node
/* ============================================================================
 * self-host-fonts.mjs — R133: serve every web font from our own domain.
 *
 * Finds each Google Fonts stylesheet URL used in public/ (HTML <link> and CSS
 * @import), downloads that stylesheet + every .woff2 it references into
 * public/fonts/g/, rewrites the font URLs to /fonts/g/..., and points the pages
 * at the local stylesheet. Also drops the fonts.googleapis/gstatic preconnects.
 *
 *   node scripts/self-host-fonts.mjs     (one-off; needs internet, dev only)
 *
 * After this, no visitor's browser contacts Google for fonts, so the CSP can
 * drop fonts.googleapis.com / fonts.gstatic.com. The fonts are SIL OFL /
 * Apache 2.0 licensed (free to self-host); see public/fonts/g/LICENSES.txt.
 * ========================================================================== */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';

const PUB = 'public';
const OUT = join(PUB, 'fonts', 'g');
// A modern browser UA so Google serves woff2 with unicode-range subsets.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const GURL = /https:\/\/fonts\.googleapis\.com\/css2\?[^"')\s]+/g;

function walk(dir) {
  const out = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(html|css)$/.test(n)) out.push(p);
  }
  return out;
}
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const h8 = (s) => createHash('sha256').update(s).digest('hex').slice(0, 8);

mkdirSync(OUT, { recursive: true });
const files = walk(PUB).filter((f) => !f.startsWith(OUT));
const urls = new Set();
for (const f of files) for (const m of readFileSync(f, 'utf8').matchAll(GURL)) urls.add(m[0]);

const cssFor = new Map();     // google url -> /fonts/g/<name>.css
const fontFiles = new Map();  // gstatic url -> local file name
for (const url of urls) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error('stylesheet ' + res.status + ' ' + url);
  let css = await res.text();
  // One local woff2 per distinct gstatic file (variable fonts share a file across weights).
  const blocks = css.split('@font-face').slice(1);
  for (const b of blocks) {
    const fam = (b.match(/font-family:\s*'([^']+)'/) || [])[1] || 'font';
    const style = (b.match(/font-style:\s*(\w+)/) || [])[1] || 'normal';
    const src = (b.match(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/) || [])[1];
    if (!src) throw new Error('no gstatic url in block of ' + url);
    if (!fontFiles.has(src)) {
      const name = slug(fam) + (style === 'italic' ? '-italic' : '') + '-' + h8(src) + '.woff2';
      const r = await fetch(src, { headers: { 'User-Agent': UA } });
      if (!r.ok) throw new Error('font ' + r.status + ' ' + src);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.subarray(0, 4).toString('latin1') !== 'wOF2') throw new Error('not woff2: ' + src);
      writeFileSync(join(OUT, name), buf);
      fontFiles.set(src, name);
    }
  }
  css = css.replace(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g, (_, s) => 'url(/fonts/g/' + fontFiles.get(s) + ')');
  if (/https?:\/\//.test(css)) throw new Error('external url left in css for ' + url);
  const first = decodeURIComponent((url.match(/family=([^:&]+)/) || [])[1] || 'fonts').replace(/\+/g, ' ');
  const name = slug(first) + '-' + h8(url) + '.css';
  writeFileSync(join(OUT, name), '/* Self-hosted Google Fonts stylesheet (R133): ' + url.split('?')[1] + ' */\n' + css);
  cssFor.set(url, '/fonts/g/' + name);
}

let changed = 0;
for (const f of files) {
  const before = readFileSync(f, 'utf8');
  let s = before
    .replace(/[ \t]*<link rel="preconnect" href="https:\/\/fonts\.googleapis\.com">\r?\n?/g, '')
    .replace(/[ \t]*<link rel="preconnect" href="https:\/\/fonts\.gstatic\.com" crossorigin>\r?\n?/g, '')
    .replace(GURL, (u) => cssFor.get(u));
  if (s !== before) { writeFileSync(f, s); changed++; }
}
console.log('stylesheets:', cssFor.size, ' font files:', fontFiles.size, ' pages/css changed:', changed);
for (const f of files) if (/fonts\.(googleapis|gstatic)\.com/.test(readFileSync(f, 'utf8'))) console.log('STILL REFERENCES GOOGLE:', relative('.', f));
