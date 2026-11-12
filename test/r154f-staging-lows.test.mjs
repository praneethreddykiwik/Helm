// r154f-staging-lows.test.mjs - R154f: the Low findings of the R152 staging test.
//  1. legal tables stack into label / value cards on phones (data-label on every cell, no sideways scroll)
//  2. landing contrast: the faint word-fill words and the chat photo names are drawn by CSS (decoration), real text untouched
//  3. 0352: the two sign-in page e-mail checks are limited (APPLY-0352 editor-safe, MANIFEST, DB suite wired)
//  4. vercel.json: .js / .css immutable only with ?v= (vendor + content-hashed fonts by name)
//  5. the staging site's Reporting-Endpoints names the staging project, never production
// Behaviour of 0352: tests/db/r154f-email-probe-0352.sql. Browser check of 1 + 2: run by hand with Playwright (375 / 640 / 1440).
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
const ROOT = new URL('..', import.meta.url);
const r = (p) => readFileSync(new URL(p, ROOT), 'utf8');
let n = 0;
const t = (name, fn) => { try { fn(); n++; console.log('  ok ' + name); } catch (e) { console.error('  FAIL ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; } };

t('1 every legal table cell carries the column name; phones stack rows as cards, no min-width there', () => {
  const pages = readdirSync(new URL('public/', ROOT)).filter((f) => f.endsWith('.html') && r('public/' + f).includes('class="lg-table"'));
  assert.ok(pages.length >= 9, pages.join(','));
  for (const f of pages) {
    const h = r('public/' + f);
    for (const [, inner] of h.matchAll(/<table class="lg-table">([\s\S]*?)<\/table>/g)) {
      const heads = [...inner.matchAll(/<th scope="col">([\s\S]*?)<\/th>/g)].map((m) => m[1].replace(/<[^>]+>/g, '').trim());
      for (const [, row] of /<tbody>([\s\S]*?)<\/tbody>/.exec(inner)[1].matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
        const labels = [...row.matchAll(/<td( data-label="([^"]*)")?>/g)].map((m) => m[2]);
        assert.deepEqual(labels, heads.map((x) => x.replace(/"/g, '&quot;')), f + ' row labels');
      }
    }
    assert.match(h, /\/legal\.css\?v=8"/, f);
  }
  const css = r('public/legal.css');
  const mq = /\/\* R154f[^\n]*\n@media \(max-width:640px\)\{([\s\S]*?)\n\}/.exec(css);
  assert.ok(mq, 'phone block');
  assert.match(mq[1], /\.lg-table-wrap\{overflow:visible;/);
  assert.match(mq[1], /\.lg-table\{min-width:0\}/);
  assert.match(mq[1], /\.lg-table,\.lg-table tbody,\.lg-table tr,\.lg-table td\{display:block;width:100%\}/);
  assert.match(mq[1], /\.lg-table td\[data-label\]::before\{content:attr\(data-label\);/);
  assert.match(mq[1], /\.lg-table thead\{position:absolute;width:1px;height:1px;/, 'header row kept for screen readers, hidden visually');
  assert.match(css, /\.lg-table\{width:100%;border-collapse:collapse;font-size:14px;min-width:520px\}/, 'desktop / tablet table unchanged');
});

t('2 landing: faint fill words + chat photo names are CSS-drawn decoration; the readable copy stays text', () => {
  const js = r('public/home.js'), css = r('public/home.css'), html = r('public/index.html');
  assert.match(js, /var sp = el\('span', 'fw'\); sp\.setAttribute\('data-w', w\); sp\.setAttribute\('aria-hidden', 'true'\);/);
  assert.match(js, /var sr = el\('span', 'sr', words\.join\(' '\)\); line\.appendChild\(sr\);/, 'screen-reader copy of the line kept');
  assert.match(css, /\.fw\{color:rgba\(16,21,17,\.16\);transition:color \.5s var\(--out\)\}\.fw\.on\{color:var\(--ink\)\}\.fw::before\{content:attr\(data-w\)\}/);
  assert.match(css, /\.cb\.pic::after\{content:attr\(data-f\)\}/);
  assert.match(html, /<div class="vig vig-chat" aria-hidden="true">[\s\S]*?<p class="cb in pic" data-f="advance_receipt\.jpg"><i><\/i><\/p>[\s\S]*?<p class="cb in pic" data-f="stage_ref_3\.jpg"><i><\/i><\/p>/);
  assert.match(html, /\/home\.css\?v=40"/); assert.match(html, /\/home\.js\?v=41"/);
});

t('3 0352: APPLY = header + begin + migration verbatim + commit + VERIFY; editor-safe; additive; wired', () => {
  const M = r('supabase/migrations/0352_r154f_email_probe_limits.sql'), A = r('supabase/APPLY-0352.sql');
  assert.match(A, /^-- APPLY-0352 \(R154f sign-in page e-mail check limits\)\. Run on STAGING first, then production\. Safe to run twice\.\nbegin;\n/);
  assert.ok(A.includes('\nbegin;\n' + M.replace(/\s*$/, '\n') + 'commit;\n'));
  assert.equal((A.match(/^begin;$/gm) || []).length, 1); assert.equal((A.match(/^commit;$/gm) || []).length, 1);
  assert.match(A, /\ncommit;\n\n-- VERIFY every line should say true\nselect item, ok from \(values\n[\s\S]*\n\) v\(item, ok\);\n$/);
  for (const s of [M, A]) {
    assert.ok(/^[\x09\x0a\x20-\x7e]*$/.test(s), 'ASCII only');
    for (const l of s.split('\n')) {
      const c = l.indexOf('--'); if (c < 0) continue;
      if ((l.slice(0, c).match(/'/g) || []).length % 2) continue;
      assert.doesNotMatch(l.slice(c), /['";]/, 'comment with a quote or semicolon: ' + l);
    }
    assert.doesNotMatch(s, /^\s*\\/m); assert.doesNotMatch(s, /\bcreate\s+(temp|temporary)\s+table\b/i); assert.doesNotMatch(s, /^\s*(set|reset)\s+/im);
    assert.doesNotMatch(s.replace(/^--.*$/gm, ''), /\b(drop|delete|truncate|alter table|update)\b/i, 'additive only');
  }
  assert.match(M, /if position\('r352-0352' in v_src\) > 0 then[\s\S]*elsif position\(f\.mark in v_src\) = 0 then\n\s*raise exception 'STOP 0352/, 'unknown live body -> STOP, nothing changed');
  assert.match(M, /public\.rate_hit\('r352_' \|\| p_kind \|\| '\.ip',[\s\S]*600, 20\) > 0 then\n\s*return false;/);
  assert.match(M, /public\.rate_hit\('r352_' \|\| p_kind \|\| '\.email',[\s\S]*600, 20\) > 0 then\n\s*return false;/);
  assert.match(M, /exception when others then\n\s*return false;/, 'counter that cannot be written -> false (fail closed)');
  assert.match(M, /if not public\._r352_allow\('preauth', p_email\) then return false; end if;\n\s*return public\.signup_email_preauthorised__pre0352\(p_email\);/);
  assert.match(M, /if not public\._r352_allow\('staff_google', p_email\) then return false; end if;\n\s*return public\.staff_google_only_for__pre0352\(p_email\);/);
  const man = r('supabase/migrations/MANIFEST');
  assert.equal((man.match(/^forward  supabase\/migrations\/0352_r154f_email_probe_limits\.sql$/gm) || []).length, 1);
  assert.match(r('scripts/db-test/run-all.sh'), /run "r154f-email-probe-0352" "R154F-EMAIL-PROBE-0352: ALL PASS \\\(\d+\/\d+\\\)" psql -q -f tests\/db\/r154f-email-probe-0352\.sql/);
  for (const f of ['test/release-1019.test.mjs', 'test/release-1020.test.mjs']) assert.match(r(f), /'0352'[,\]]/, f);   // R155: later numbers (0353) may follow
  // the pages treat any error / false as "no" (unchanged; store-api.js is not touched by this round)
  const S = r('public/store-api.js');
  assert.match(S, /supa\.rpc\("signup_email_preauthorised", \{ p_email: String\(email\)\.trim\(\)\.toLowerCase\(\) \}\); return !r\.error && r\.data === true;/);
  assert.match(S, /supa\.rpc\("staff_google_only_for", \{ p_email: String\(email\)\.trim\(\)\.toLowerCase\(\) \}\); return !r\.error && r\.data === true;/);
});

t('4 vercel.json: .js / .css immutable only with ?v=; vendor + fonts/g by name; images unchanged', () => {
  const V = JSON.parse(r('vercel.json'));
  const IM = 'public, max-age=31536000, immutable';
  const rule = (src) => V.headers.filter((x) => x.source === src);
  const js = rule('/(.*)\\.(js|css)');
  assert.equal(js.length, 1); assert.deepEqual(js[0].has, [{ type: 'query', key: 'v' }]); assert.equal(js[0].headers[0].value, IM);
  assert.equal(rule('/(.*)\\.(png|webp|svg|woff2)')[0].headers[0].value, IM);
  assert.equal(rule('/vendor/(.*)')[0].headers[0].value, IM);
  assert.equal(rule('/fonts/g/(.*)')[0].headers[0].value, IM);
  assert.ok(!V.headers.some((x) => !x.has && /\(js\|css/.test(x.source) && x.headers.some((h) => h.value === IM)), 'no extension-only js/css immutable rule left');
  const i = (src) => V.headers.findIndex((x) => x.source === src);
  assert.ok(i('/(.*)\\.(js|css)') < i('/config\\.js'), 'config.js?v= stays short-lived (its rule comes later)');
});

t('5 staging site: Reporting-Endpoints names the staging project; the catch-all (production) keeps production', () => {
  const V = JSON.parse(r('vercel.json'));
  const stg = V.headers.find((x) => x.source === '/(.*)' && x.has && x.has[0].type === 'host' && x.has[0].value === 'helm-v01.vercel.app' && x.headers[0].key === 'Content-Security-Policy');
  const re = stg.headers.find((h) => h.key === 'Reporting-Endpoints');
  assert.equal(re.value, 'csp-endpoint="https://xizehqgeyjcfpzrdymly.supabase.co/functions/v1/csp-report"');
  assert.ok(!JSON.stringify(stg).includes('nqltzgiwznphugcfhmbm'), 'staging rule never names production');
  const all = V.headers.find((x) => x.source === '/(.*)' && !x.has);
  assert.equal(all.headers.find((h) => h.key === 'Reporting-Endpoints').value, 'csp-endpoint="https://nqltzgiwznphugcfhmbm.supabase.co/functions/v1/csp-report"');
  assert.ok(V.headers.indexOf(stg) > V.headers.indexOf(all), 'staging rule comes later, so it wins on the staging host');
  assert.match(r('scripts/gen-csp.mjs'), /\{ key: 'Reporting-Endpoints', value: reportingEndpoints\(cspReportUri\(STAGING_REF\)\) \}/);
});

console.log(`r154f-staging-lows: ${n} checks passed`);
