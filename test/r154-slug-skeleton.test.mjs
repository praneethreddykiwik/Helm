// r154-slug-skeleton.test.mjs - R154: studio Settings save refused on prod with 42501 "permission denied for function
// _r23_slug_skeleton". 0257 indexes organizations.public_slug + org_slug_history.slug on that helper and revoked it from
// signed-in users; 0346 grants EXECUTE back to authenticated (anon + PUBLIC stay without it). Static guarantees here;
// behaviour (the prod error reproduced, then fixed): tests/db/r154-slug-skeleton-0346.sql.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const ROOT = new URL('..', import.meta.url);
const r = (p) => readFileSync(new URL(p, ROOT), 'utf8');
let n = 0;
const t = (name, fn) => { try { fn(); n++; console.log('  ok ' + name); } catch (e) { console.error('  FAIL ' + name + '\n' + (e && e.stack || e)); process.exit(1); } };

const M = r('supabase/migrations/0346_r154_slug_skeleton_execute.sql'), A = r('supabase/APPLY-0346.sql'), mf = r('supabase/migrations/MANIFEST');
const code = (s) => s.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');

t('the cause is still what 0346 fixes: 0257 indexes on the helper + revokes it from authenticated', () => {
  const b = r('supabase/migrations/0257_studio_name_link.sql');
  assert.match(b, /create index if not exists organizations_r23_slug_skel_idx on public\.organizations \(public\._r23_slug_skeleton\(public_slug\)\);/);
  assert.match(b, /create index if not exists org_slug_history_r23_skel_idx on public\.org_slug_history \(public\._r23_slug_skeleton\(slug\)\);/);
  assert.match(b, /'public\._r23_slug_skeleton\(text\)'/);
  assert.match(b, /else execute format\('revoke all on function %s from authenticated', f\); end if;/);
});

t('0346: MANIFEST once, after 0344 (and after 0257), plain words, nothing dropped, safe to run twice', () => {
  const line = 'forward  supabase/migrations/0346_r154_slug_skeleton_execute.sql';
  assert.equal(mf.split('\n').filter((l) => l === line).length, 1);
  assert.ok(mf.indexOf('forward  supabase/migrations/0257_studio_name_link.sql') < mf.indexOf(line));
  assert.ok(mf.indexOf('forward  supabase/migrations/0344_r149_missing_indexes.sql') < mf.indexOf(line));
  assert.match(mf, /# 0346 \(R154[^\n]*Nothing dropped or deleted\. Safe to run twice\./);
  for (const f of ['test/release-1019.test.mjs', 'test/release-1020.test.mjs']) assert.match(r(f), /'0344', '0346'\]/, f);
});

t('0346: grants only - EXECUTE to authenticated + service_role, revoked from PUBLIC + anon, no body / table touched', () => {
  const c = code(M);
  assert.match(c, /grant execute on function public\._r23_slug_skeleton\(text\) to authenticated/);
  assert.match(c, /grant execute on function public\._r23_slug_skeleton\(text\) to service_role/);
  assert.match(c, /revoke all on function public\._r23_slug_skeleton\(text\) from public/);
  assert.match(c, /revoke all on function public\._r23_slug_skeleton\(text\) from anon/);
  assert.doesNotMatch(c, /grant [^\n]* to (anon|public)\b/i);
  assert.equal((c.match(/\bgrant\b/gi) || []).length, 2, 'exactly two grants');
  assert.doesNotMatch(c, /\b(create|drop|alter|delete|truncate|update|insert)\b/i);
  assert.match(c, /STOP 0346: public\._r23_slug_skeleton\(text\) is missing - apply 0257 first/);
});

t('APPLY-0346: one header, begin + migration verbatim + commit, VERIFY last; editor-safe comments; ASCII', () => {
  assert.match(A, /^-- APPLY-0346 \(R154 [^\n]*\)\. Run on STAGING first, then production\. Safe to run twice\.\n/);
  assert.ok(A.includes('\nbegin;\n' + M.replace(/\s*$/, '\n') + '\ncommit;\n'));
  assert.equal((A.match(/^begin;$/gm) || []).length, 1); assert.equal((A.match(/^commit;$/gm) || []).length, 1);
  assert.match(A, /\ncommit;\n\n-- VERIFY every line should say true\nselect item, ok from \(values\n[\s\S]*\n\) v\(item, ok\) order by item;\n$/);
  assert.match(A, /anon still cannot run the look-alike helper/);
  for (const s of [M, A]) {
    assert.ok(/^[\x09\x0a\x20-\x7e]*$/.test(s), 'ASCII only');
    for (const l of s.split('\n')) {
      const c = l.indexOf('--'); if (c < 0) continue;
      if ((l.slice(0, c).match(/'/g) || []).length % 2) continue;
      assert.doesNotMatch(l.slice(c), /['";]/, 'comment with a quote or semicolon: ' + l);
    }
    assert.doesNotMatch(s, /^\s*\\/m); assert.doesNotMatch(s, /\bcreate\s+(temp|temporary)\s+table\b/i);
    assert.doesNotMatch(s, /^\s*(set|reset)\s+/im);
  }
});

t('prod checker knows 0346 (execute authenticated on the helper); DB suite wired into run-all.sh', () => {
  assert.match(r('supabase/check-prod-overrides.json'), /"0346": \{[^\n]*"execute authenticated public\._r23_slug_skeleton\(text\)"/);
  assert.match(r('supabase/CHECK-PROD-MIGRATIONS.sql'), /\('0346_r154_slug_skeleton_execute', 'exec', 'public', '_r23_slug_skeleton', 'text\|authenticated'\)/);
  assert.match(r('supabase/CHECK-PROD-MIGRATIONS.sql'), /when 'exec' then exists \(select 1 from pg_proc p join pg_roles g/);
  assert.match(r('scripts/db-test/run-all.sh'), /run "r154-slug-skeleton-0346" "R154-SLUG-SKELETON-0346: ALL PASS \\\(\d+\/\d+\\\)" psql -q -f tests\/db\/r154-slug-skeleton-0346\.sql/);
});

console.log(`r154-slug-skeleton: ${n} passed`);
