// Audit D (18 Nov 2026, data + infra): 0393 adds two list indexes for the newest-first Leads / Quotes pages.
//  The app pages ask row-security-scoped lists ordered by updated_at desc, id desc (store-api leads.page / quotes.page);
//  the DB suite tests/db/audit-d-list-indexes-0393.sql proves the plan and the same answers on seeded volume.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('  ✓ ' + name); };
const M = read('supabase/migrations/0393_audit_d_list_indexes.sql');
const A = read('supabase/APPLY-0393.sql');
const C = read('supabase/APPLY-0393-CONCURRENT.sql');
const MF = read('supabase/migrations/MANIFEST');
const S = read('public/store-api.js');
const IDX = ['ix_leads_org_updated_0393 on public.leads (org_id, updated_at desc, id desc)',
  'ix_quotes_org_updated_0393 on public.quotes (org_id, updated_at desc, id desc)'];

await t('0393: additive only (two create index if not exists), ASCII, paste-safe comments', () => {
  const code = M.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
  for (const x of IDX) assert.ok(code.includes('create index if not exists ' + x + ';'), x);
  assert.doesNotMatch(code, /\b(drop|delete|truncate|alter|update|insert|grant|revoke)\b/i);
  assert.ok(/^[\x00-\x7F]*$/.test(M), 'ASCII only');
  for (const l of M.split('\n').filter((x) => /^\s*--/.test(x))) assert.doesNotMatch(l, /['";]/, 'comment: ' + l);
});

await t('APPLY-0393 = the migration + a final all-true check list; CONCURRENT = the same two indexes one line each', () => {
  assert.match(A, /^-- APPLY-0393 \(Audit D [^\n]*\)\. Run on STAGING first, then production\. Safe to run twice\.\n/);
  const body = A.slice(A.indexOf('begin;\n') + 7, A.indexOf('\nselect item, ok from (values'));
  assert.equal(body.trim(), M.trim());
  assert.match(A, /select item, ok from \(values\n[\s\S]+\) v\(item, ok\) order by item;\ncommit;\n$/);
  for (const l of A.split('\n').filter((x) => /^\s*--/.test(x))) assert.doesNotMatch(l, /['";]/, 'comment: ' + l);
  assert.doesNotMatch(C, /^\s*(begin|commit)\s*;/im);
  const lines = C.split('\n').filter((l) => /^create index/.test(l));
  assert.equal(lines.length, 2);
  for (const x of IDX) assert.ok(lines.includes('create index concurrently if not exists ' + x + ';'), x);
  for (const l of C.split('\n').filter((x) => /^\s*--/.test(x))) assert.doesNotMatch(l, /['";]/, 'comment: ' + l);
});

await t('MANIFEST + DB suite + prod checker know 0393', () => {
  assert.ok(MF.includes('forward  supabase/migrations/0393_audit_d_list_indexes.sql'));
  assert.match(read('scripts/db-test/run-all.sh'), /run "audit-d-list-indexes-0393" "AUDIT-D-LIST-INDEXES-0393: ALL PASS \\\(11\/11\\\)" psql -q -f tests\/db\/audit-d-list-indexes-0393\.sql/);
  const chk = read('supabase/CHECK-PROD-MIGRATIONS.sql');
  assert.ok(chk.includes('ix_leads_org_updated_0393') && chk.includes('ix_quotes_org_updated_0393'));
});

await t('the app lists still ask newest-first (the order the indexes serve)', () => {
  assert.match(S, /sbPage\(q\.order\("updated_at", \{ ascending: false \}\)\.order\("id", \{ ascending: false \}\), o\)/);
  assert.match(S, /return q\.order\("updated_at", \{ ascending: false \}\)\.order\("id", \{ ascending: false \}\);/);
});

console.log(`audit-d-0393: ${n} passed`);
