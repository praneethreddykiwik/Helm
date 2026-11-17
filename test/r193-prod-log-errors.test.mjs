// R193: errors from the production Postgres / API log (16-17 Nov 2026).
//  1  booklet reads (booklet_layout_auto_on / booklet_current / booklet_image_info) -> HTTP 500 "event not found":
//     0375 answers "nothing" for an event that is not the caller's; the quote page's widgets wait for the page's own
//     quote check (window.HelmPageQuote) and ask nothing about a quote that was not found.
//  2  anon "permission denied for table audit_log / function live_events_today": the anon-key guard now covers them.
//  4  Realtime "invalid column for filter quote_id": rtLive() joins only with a live access token (see r163-perf).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('  ✓ ' + name); };
const S = read('public/store-api.js');
const M = read('supabase/migrations/0375_r193_booklet_soft_reads.sql');
const A = read('supabase/APPLY-0375.sql');
const MF = read('supabase/migrations/MANIFEST');

await t('0375: the four booklet reads use the soft helper; the helper keeps every 42501 check; writes untouched', () => {
  const code = M.replace(/^--.*$/gm, '');
  for (const f of ['booklet_current(p_quote_id uuid)', 'booklet_layout_auto_on(p_quote_id uuid)', 'booklet_image_info(p_quote_id uuid)',
    'booklet_staff_image(p_quote_id uuid, p_kind text, p_variant text)']) {
    const i = code.indexOf('create or replace function public.' + f); assert.ok(i > 0, f);
    const body = code.slice(i, code.indexOf('end $$;', i));
    const edit = f.startsWith('booklet_layout_auto_on') ? 'true' : 'false';   // layout_auto_on still needs quotes EDIT
    assert.match(body, new RegExp('v_org := public\\._booklet_staff_quote_soft\\(p_quote_id, ' + edit + '\\);\\n\\s+if v_org is null then return '), f);
    assert.doesNotMatch(body, /P0002/, f);
  }
  const h = code.slice(code.indexOf('function public._booklet_staff_quote_soft'), code.indexOf('end $$;', code.indexOf('function public._booklet_staff_quote_soft')));
  assert.equal((h.match(/errcode = '42501'/g) || []).length, 3, 'signed out / no role or client / no quotes area: still refused');
  assert.match(h, /public\.has_area\('quotes', case when p_edit then 'edit' else 'view' end\)/);
  assert.match(h, /q\.org_id = v_org and q\.deleted_at is null;\n\s+if v_q is null then return null; end if;/);
  assert.match(M, /revoke all on function public\._booklet_staff_quote_soft\(uuid, boolean\) from authenticated/);
  for (const w of ['booklet_share', 'booklet_revoke', 'booklet_set_sections', 'booklet_put_image', 'booklet_set_image_variants'])
    assert.ok(!new RegExp('function public\\.' + w + '\\(').test(code), w + ' is not re-issued');
  assert.doesNotMatch(code, /\bdrop\s+(table|function|policy|index|trigger)\b|\bdelete\s+from\b|\btruncate\b|\bupdate\s+public\./i);
  assert.ok(/^[\x00-\x7F]*$/.test(M), 'ASCII only');
});

await t('APPLY-0375 = the migration + a final all-true check list; MANIFEST + checker + DB suite wired', () => {
  assert.match(A, /^-- APPLY-0375 \(R193 [^\n]*\)\. Run on STAGING first, then production\. Safe to run twice\.\n/);
  const body = A.slice(A.indexOf('begin;\n') + 7, A.indexOf('\n-- ---- checks: every ok must be true'));
  assert.equal(body.trim(), M.trim());
  assert.match(A, /select item, ok from \(values\n[\s\S]+\) v\(item, ok\) order by item;\ncommit;\n$/);
  assert.ok(MF.includes('forward  supabase/migrations/0375_r193_booklet_soft_reads.sql'));
  assert.match(read('supabase/check-prod-overrides.json'), /"0375": \{ "note": "booklet soft reads[^\n]*"marker public\.booklet_current\(uuid\) r193-0375"/);
  assert.match(read('scripts/db-test/run-all.sh'), /run "r193-booklet-soft-0375" "R193-BOOKLET-SOFT-0375: ALL PASS \\\(14\/14\\\)" psql -q -f tests\/db\/r193-booklet-soft-0375\.sql/);
});

await t('anon-key guard: audit_log + live_events_today + the booklet reads are never sent signed out; public RPCs still pass', () => {
  const m = S.match(/const SIGNED_IN_ONLY = (\/.*\/);/); assert.ok(m);
  const R = eval(m[1]); const B = 'https://x.supabase.co/rest/v1/';
  for (const u of ['audit_log?select=*&order=at.desc&limit=12', 'rpc/live_events_today', 'rpc/booklet_current', 'rpc/booklet_image_info',
    'rpc/booklet_staff_image', 'rpc/booklet_layout_auto_on', 'leads?select=*', 'quotes?select=id', 'chat_members'])
    assert.ok(R.test(B + u), u);
  for (const u of ['rpc/public_get_booklet', 'rpc/public_get_booklet_image', 'rpc/booklet_current_x', 'audit_logx', 'rpc/live_events_todayx'])
    assert.ok(!R.test(B + u), u);
});

await t('flow.html / event.html publish their quote check; resolved null on not found / no id, the id once opened', () => {
  const F = read('public/flow.html'), E = read('public/event.html');
  for (const H of [F, E]) assert.match(H, /let pageQuoteDone=\(\)=>\{\}; window\.HelmPageQuote=new Promise\(r=>\{ pageQuoteDone=r; \}\);/);
  assert.match(F, /if\(BPUI\.isNotFound\(e\)\)\{ pageQuoteDone\(null\); showNotFound\(\); return; \}/);
  assert.match(F, /if\(!ev\)\{ pageQuoteDone\(null\); showNotFound\(\); return; \}\n\s+pageQuoteDone\(ev\.id\|\|id\);/);
  assert.match(F, /if\(!id\)\{ pageQuoteDone\(null\);/);
  assert.match(F, /if\(!rid\)\{ pageQuoteDone\(null\); showNotFound\(\); return; \}/);
  assert.match(E, /if\(!id\)\{ pageQuoteDone\(null\); \$\("#notfound"\)\.hidden=false; return; \}/);
  assert.match(E, /if\(BPUI\.isNotFound\(e\)\)\{ pageQuoteDone\(null\); \$\("#notfound"\)\.hidden=false; \}/);
  assert.match(E, /pageQuoteDone\(ev && ev\.id \? ev\.id : null\);/);
});

await t('share card / link views / quote validity wait for the page check (and behave as before without one)', async () => {
  const SC = read('public/share-checklist.js'), LV = read('public/link-views.js'), QV = read('public/quote-validity.js');
  assert.match(SC, /if \(!quoteId\) \{[^\n]*\n\s+if \(!\(await pageQuoteOk\(quoteId\)\)\) \{ card\.hidden = true; return; \}\n[^\n]*\n\s+\/\/ r19 L11[^\n]*\n\s+try \{ if \(st\.booklet && typeof st\.booklet\.layoutAutoOn/);
  assert.match(LV, /async function paint\(fresh\) \{\n\s+if \(!\(await pageQuoteOk\(id\)\)\) \{ el\.hidden = true; return; \}/);
  assert.match(QV, /if \(!quoteId && !\(await pageQuoteOk\(id\)\)\) \{ el\.hidden = true; return null; \}/);
  const grab = (src) => { const m = /function pageQuoteOk\(id\) \{[\s\S]*?\n  \}/.exec(src); assert.ok(m); return m[0]; };
  const id = 'a0000000-0000-4000-8000-00000000da01';
  for (const src of [SC, LV, QV]) {
    const mk = (g) => vm.runInNewContext('(' + grab(src).replace('function pageQuoteOk', 'function') + ')', { global: g, String, Promise });
    assert.equal(await mk({})(id), true, 'no page check: unchanged');
    assert.equal(await mk({ HelmPageQuote: Promise.resolve(null) })(id), false, 'not found: nothing asked');
    assert.equal(await mk({ HelmPageQuote: Promise.resolve(id.toUpperCase()) })(id), true, 'the opened quote');
    assert.equal(await mk({ HelmPageQuote: Promise.resolve('b0000000-0000-4000-8000-00000000da01') })(id), false, 'another quote');
    assert.equal(await mk({ HelmPageQuote: Promise.reject(new Error('x')) })(id), false, 'a failed check');
  }
});

console.log(`r193-prod-log-errors: ${n} passed`);
