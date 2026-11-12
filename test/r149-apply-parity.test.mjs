// r149-apply-parity.test.mjs - R149: every single-number paste file supabase/APPLY-NNNN.sql creates every function its
// canonical migration supabase/migrations/NNNN_*.sql creates (same name + argument types). APPLY-0165 had left out
// comms_outbox_unsub, so prod + staging never got it and comms-dispatch skipped every follow-up e-mail (fail closed).
// Plus the static guarantees of 0344 (missing indexes + comms_outbox_unsub back). Behaviour: tests/db/r149-indexes-0344.sql.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
const ROOT = new URL('..', import.meta.url);
const r = (p) => readFileSync(new URL(p, ROOT), 'utf8');
let n = 0;
const t = (name, fn) => { try { fn(); n++; console.log('  ok ' + name); } catch (e) { console.error('  FAIL ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; } };

// ---- function signatures created by a SQL file -------------------------------------------------------------------
const MULTI = /^(double precision|timestamp(\(\d+\))? with(out)? time zone|time(\(\d+\))? with(out)? time zone|character varying|bit varying)\b/i;
const ALIAS = { 'timestamp with time zone': 'timestamptz', integer: 'int', int4: 'int', boolean: 'bool', 'character varying': 'varchar',
  bigint: 'int8', smallint: 'int2', 'double precision': 'float8' };
function splitTop(s) {
  const out = []; let d = 0, q = false, cur = '';
  for (const ch of s) {
    if (ch === "'") q = !q;
    if (!q && ch === '(') d++;
    if (!q && ch === ')') d--;
    if (!q && d === 0 && ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}
function argType(a) {   // the type of one parameter, or null for an OUT parameter (not part of the signature)
  let s = a.replace(/\s+/g, ' ').trim().replace(/\s+(default\s|=).*$/i, '').trim();
  const m = s.match(/^(in|out|inout|variadic)\s+/i);
  if (m) { if (m[1].toLowerCase() === 'out') return null; s = s.slice(m[0].length); }
  if (!MULTI.test(s)) { const tok = s.split(' '); if (tok.length > 1) s = tok.slice(1).join(' '); }   // drop the parameter name
  s = s.toLowerCase().replace(/^public\./, '').replace(/\s*\[\s*\]/g, '[]');
  return ALIAS[s] || s;
}
export function functionsOf(sql) {
  const out = new Set();
  const re = /create\s+(?:or\s+replace\s+)?function\s+(?:"?public"?\.)?"?([a-z_][a-z0-9_]*)"?\s*\(/gi;
  let m;
  while ((m = re.exec(sql))) {
    let i = re.lastIndex, d = 1;
    while (i < sql.length && d > 0) { if (sql[i] === '(') d++; else if (sql[i] === ')') d--; i++; }
    out.add(m[1].toLowerCase() + '(' + splitTop(sql.slice(re.lastIndex, i - 1)).map(argType).filter((x) => x !== null).join(',') + ')');
  }
  return out;
}

// paste files allowed to differ from their migration, with the reason (none today - add here, never silently)
const ALLOW = {};

const MIG = readdirSync(new URL('supabase/migrations/', ROOT)).filter((f) => /^\d{4}_.*\.sql$/.test(f));
const APPLIES = readdirSync(new URL('supabase/', ROOT)).filter((f) => /^APPLY-\d{4}\.sql$/.test(f)).sort();

t('the signature reader sees names + argument types (OUT params, defaults, names, multi-word types)', () => {
  const f = functionsOf(`create or replace function public.a(p_id uuid, out x int) returns int as $$ $$;
    CREATE FUNCTION b(p text default 'x, y', p_at timestamp with time zone = now(), variadic v text[]) returns void as $$ $$;
    create or replace function public.c() returns void as $$ $$;`);
  assert.deepEqual([...f].sort(), ['a(uuid)', 'b(text,timestamptz,text[])', 'c()']);
});

t(`every single-number APPLY-NNNN.sql creates every function of migrations/NNNN (${APPLIES.length} paste files)`, () => {
  assert.ok(APPLIES.length > 200, 'paste files found: ' + APPLIES.length);
  const bad = [];
  let checked = 0, fnCount = 0;
  for (const a of APPLIES) {
    const num = a.slice(6, 10);
    const ms = MIG.filter((f) => f.startsWith(num + '_'));
    assert.equal(ms.length, 1, a + ': expected exactly one migrations/' + num + '_*.sql, found ' + ms.length);
    const want = functionsOf(r('supabase/migrations/' + ms[0])), have = functionsOf(r('supabase/' + a));
    const miss = [...want].filter((x) => !have.has(x) && !(ALLOW[a] || []).includes(x));
    if (miss.length) bad.push(a + ' is missing ' + miss.join(', ') + ' (from ' + ms[0] + ')');
    checked++; fnCount += want.size;
  }
  assert.deepEqual(bad, [], bad.join('\n'));
  assert.ok(checked === APPLIES.length && fnCount > 1000, 'checked ' + checked + ' files, ' + fnCount + ' functions');
});

t('the allowlist only names real paste files, each with a reason', () => {
  for (const [k, v] of Object.entries(ALLOW)) { assert.ok(APPLIES.includes(k), k); assert.ok(Array.isArray(v) && v.length, k); }
});

// ---- APPLY-0165 regenerated: the migration verbatim, one transaction, VERIFY after commit -----------------------------
const M165 = r('supabase/migrations/0165_email_unsubscribe.sql'), A165 = r('supabase/APPLY-0165.sql');
t('APPLY-0165 = 3 header lines + begin + migrations/0165 byte for byte + commit + VERIFY (with comms_outbox_unsub)', () => {
  const lines = A165.split('\n');
  assert.match(lines[0], /^-- APPLY-0165\.sql - paste into the Supabase SQL editor/);
  assert.match(lines[2], /^-- R149: regenerated to match migrations\/0165 exactly/);
  assert.equal(lines[3], 'begin;');
  const body = A165.slice(A165.indexOf('begin;\n') + 'begin;\n'.length, A165.indexOf('\ncommit;\n'));
  assert.equal(body, M165.replace(/\s*$/, '\n'));
  assert.ok(A165.indexOf('commit;') < A165.indexOf('-- VERIFY'));
  assert.match(A165, /'16 comms_outbox_unsub for the dispatcher only'/);
  assert.ok(functionsOf(A165).has('comms_outbox_unsub(uuid)'));
  assert.match(A165, /'public\.email_unsub_set\(text, boolean, text\)', 'public\.comms_outbox_unsub\(uuid\)'\] loop\n\s+execute format\('grant execute on function %s to service_role'/);
});

// ---- 0344 ---------------------------------------------------------------------------------------------------------
const M = r('supabase/migrations/0344_r149_missing_indexes.sql'), A = r('supabase/APPLY-0344.sql'), C = r('supabase/APPLY-0344-CONCURRENT.sql');
const code = M.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
const IX = [...M.matchAll(/^create index if not exists (ix_[a-z0-9_]+_0344) on public\.([a-z_]+) \(([a-z_, ]+)\);$/gm)];
const fnBody = (s) => { const m = s.match(/create or replace function public\.comms_outbox_unsub\(p_id uuid\)\n[\s\S]*?\nend \$\$;\n/); return m && m[0]; };

t('0344: in the MANIFEST once, after 0340, plain words, nothing dropped, safe to run twice', () => {
  const mf = r('supabase/migrations/MANIFEST');
  assert.equal((mf.match(/^forward  supabase\/migrations\/0344_r149_missing_indexes\.sql$/gm) || []).length, 1);
  assert.ok(mf.indexOf('forward  supabase/migrations/0340_r136_audit_via.sql') < mf.indexOf('forward  supabase/migrations/0344_r149_missing_indexes.sql'));
  assert.match(mf, /# 0344 \(R149[^\n]*Nothing dropped or deleted\. Safe to run twice\./);
  assert.ok(!/migrations\/0339_/.test(mf), '0339 is not a migration');
  // R152: the release has 0341 (R139), 0342 (R143), 0343 (R148) too - each once, in number order before 0344
  const pos = ['0340', '0341', '0342', '0343', '0344'].map((k) => { const m = mf.match(new RegExp('^forward  supabase/migrations/' + k + '_[^\\n]*$', 'gm')) || []; assert.equal(m.length, 1, k); return mf.indexOf(m[0]); });
  assert.deepEqual([...pos].sort((x, y) => x - y), pos, 'MANIFEST order 0340 < 0341 < 0342 < 0343 < 0344');
});

t('0344: additive only - 34 "create index if not exists", no drop / delete / truncate / alter table / update, no grant widened', () => {
  assert.equal(IX.length, 34);
  assert.equal((code.match(/\bcreate\s+(unique\s+)?index\b/gi) || []).length, 34);
  assert.equal(new Set(IX.map((m) => m[1])).size, 34, 'index names unique');
  for (const m of IX) assert.equal(m[1], 'ix_' + m[2] + '_' + m[3].replace(/, /g, '_') + '_0344', 'name = ix_<table>_<cols>_0344');
  assert.doesNotMatch(code, /\bdrop\b/i); assert.doesNotMatch(code, /\bdelete\s+from\b/i); assert.doesNotMatch(code, /\btruncate\b/i);
  assert.doesNotMatch(code, /\balter\s+(table|function|index)\b/i); assert.doesNotMatch(code, /\bupdate\s+public\./i);
  assert.doesNotMatch(code, /\bcreate\s+(unique\s+)?index\s+(?!if not exists)/i);
  assert.equal((code.match(/\bgrant\b/gi) || []).length, 1);
  assert.match(code, /execute 'grant execute on function public\.comms_outbox_unsub\(uuid\) to service_role'/);
  for (const who of ['public', 'anon', 'authenticated']) assert.match(code, new RegExp(`execute 'revoke all on function public\\.comms_outbox_unsub\\(uuid\\) from ${who}'`));
});

t('0344: the 15 row-security org_id tables + the quote -> lead sync index are there', () => {
  const names = IX.map((m) => m[1]);
  for (const tb of ['chat_reactions', 'client_booklets', 'client_link_opens', 'event_checkin_sites', 'event_files', 'inbox_person_prefs',
    'notification_mutes', 'open_shift_claims', 'package_selections', 'pkg_credits', 'profiles', 'quotation_versions', 'quote_validity_log',
    'user_dashboard_prefs', 'user_recent_records']) assert.ok(names.includes(`ix_${tb}_org_id_0344`), tb);
  assert.ok(names.includes('ix_leads_quote_id_0344'));
});

t('0344: comms_outbox_unsub is the 0165 function byte for byte (what comms-dispatch calls)', () => {
  assert.ok(fnBody(M165)); assert.equal(fnBody(M), fnBody(M165));
  const ts = r('supabase/functions/comms-dispatch/index.ts');
  assert.match(ts, /admin\.rpc\("comms_outbox_unsub", \{ p_id: id \}\)/);
  assert.match(ts, /if \(!u \|\| u\.ok !== true \|\| u\.opted_out === true\) return null;/);   // missing function -> null -> skipped
  for (const k of ["'ok', true", "'opted_out'", "'token'"]) assert.ok(fnBody(M).includes(k), k);
});

t('APPLY-0344: one header, begin + the migration verbatim + commit, VERIFY last; editor-safe comments; ASCII', () => {
  assert.match(A, /^-- APPLY-0344 \(R149 missing indexes \+ comms_outbox_unsub\)\. Run on STAGING first, then production\. Safe to run twice\.\n/);
  assert.ok(A.includes('\nbegin;\n' + M.replace(/\s*$/, '\n') + '\ncommit;\n'));
  assert.equal((A.match(/^begin;$/gm) || []).length, 1); assert.equal((A.match(/^commit;$/gm) || []).length, 1);
  assert.match(A, /\ncommit;\n\n-- VERIFY every line should say true\nselect item, ok from \(values\n[\s\S]*\n\) v\(item, ok\) order by item;\n$/);
  for (const s of [M, A, C]) {
    assert.ok(/^[\x09\x0a\x20-\x7e]*$/.test(s), 'ASCII only');
    for (const l of s.split('\n')) {
      const c = l.indexOf('--'); if (c < 0) continue;
      const before = l.slice(0, c);
      if ((before.match(/'/g) || []).length % 2) continue;   // a -- inside a string literal, not a comment
      assert.doesNotMatch(l.slice(c), /['";]/, 'comment with a quote or semicolon: ' + l);
    }
    assert.doesNotMatch(s, /^\s*\\/m, 'psql meta-command'); assert.doesNotMatch(s, /\bcreate\s+(temp|temporary)\s+table\b/i);
    assert.doesNotMatch(s, /^\s*(set|reset)\s+/im, 'session setting');
  }
});

t('APPLY-0344-CONCURRENT: the same 34 indexes, one concurrently line each, no transaction, read-only check last', () => {
  const lines = [...C.matchAll(/^create index concurrently if not exists (ix_[a-z0-9_]+_0344) on (public\.[a-z_]+ \([a-z_, ]+\));$/gm)];
  assert.deepEqual(lines.map((m) => m[1] + ' ' + m[2]), IX.map((m) => m[1] + ' public.' + m[2] + ' (' + m[3] + ')'));
  assert.doesNotMatch(C, /^\s*(begin|commit|start transaction)\b/im);
  assert.doesNotMatch(C.replace(/^--.*$/gm, ''), /\b(drop|delete|truncate|alter|update|grant|function)\b/i);
  assert.match(C, /one line at a time/i); assert.match(C, /run APPLY-0344\.sql once/);
  assert.match(C, /-- CHECK \(read only\)[^\n]*\nselect c\.relname as index_name, i\.indisvalid as valid from pg_index[\s\S]*order by 1;\n$/);
});

t('DB suite wired into run-all.sh; release after-lists know 0344', () => {
  assert.match(r('scripts/db-test/run-all.sh'), /run "r149-indexes-0344" "R149-INDEXES-0344: ALL PASS \\\(\d+\/\d+\\\)" psql -q -f tests\/db\/r149-indexes-0344\.sql/);
  for (const f of ['test/release-1019.test.mjs', 'test/release-1020.test.mjs']) assert.match(r(f), /'0340', '0341', '0342', '0343', '0344'(, '\d{4}')*\]/, f);   // later migrations append after 0344
  assert.match(r('package.json'), /node test\/r149-apply-parity\.test\.mjs/);
});

console.log(`r149-apply-parity: ${n} checks passed`);
