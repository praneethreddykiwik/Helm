#!/usr/bin/env node
// gen-0343-rls-initplan.mjs - R148: builds migration 0343 (RLS speed-up) from the LIVE policy catalog of a canonical
// database (every MANIFEST migration BEFORE 0343), so the file is reproducible and reviewable.
//
// What it does, in plain words:
//   * reads every row-level-security policy (pg_policy) of the canonical database, deparsed with an EMPTY search_path
//     (so every name is schema-qualified and the text never depends on the editor's search_path);
//   * in each USING / WITH CHECK expression, wraps a call to a per-query helper - a STABLE, non-set-returning function
//     outside pg_catalog such as public.has_area('quotes'::text, 'view'::text), public.current_org_id(), auth.uid(),
//     public.is_admin() - as (SELECT <call>) when NONE of its arguments mentions a column (only literals / casts /
//     other such calls). Postgres then runs it ONCE per query (an InitPlan) instead of once per row. A call that
//     reads a column (public.chat_can_see(conversation_id)) is left alone, so is a call already wrapped, a
//     set-returning function, an IMMUTABLE function (folded by the planner already) and a call in a FROM list;
//   * applies every rewrite inside ONE rolled-back transaction of that database, reads the expression back, proves it
//     is a fixpoint (re-applying the read-back text gives the same text) and that removing every (SELECT f(..) AS f)
//     wrapper gives exactly the original expression (same boolean logic, only wrapped);
//   * writes supabase/migrations/0343_r148_rls_initplan.sql (one guarded DO block per changed policy: ALTER POLICY
//     only when the live expression still equals the canonical pre-0343 one, "already done" when it equals the
//     expected result, otherwise a NOTICE and the policy is left alone), supabase/APPLY-0343.sql (editor paste:
//     begin / migration / commit / VERIFY) and tests/db/r148-rls-initplan-0343-cases.sql (test data: the pre-0343
//     and the 0343 expression of every changed policy).
//
// Usage (local disposable PG17 only - never staging / production):
//   node scripts/gen-0343-rls-initplan.mjs --build     create a fresh database (default helm_gen0343, or $PGDATABASE)
//                                                      from the shim + every MANIFEST entry before 0343, then generate
//   node scripts/gen-0343-rls-initplan.mjs             generate from $PGDATABASE (must be a pre-0343 canonical build)
//   node scripts/gen-0343-rls-initplan.mjs --check     exit 1 if the committed files differ from a fresh generation
// Connection: the usual PG* environment (PGHOST / PGPORT / PGUSER), e.g. the scripts/db-test cluster.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_MIG = 'supabase/migrations/0343_r148_rls_initplan.sql';
const OUT_APPLY = 'supabase/APPLY-0343.sql';
const OUT_CASES = 'tests/db/r148-rls-initplan-0343-cases.sql';
const args = process.argv.slice(2);
const CHECK = args.includes('--check');
const BUILD = args.includes('--build');
const DB = process.env.PGDATABASE || 'helm_gen0343';
const env = {
  ...process.env, PGDATABASE: DB, LC_ALL: 'C', LANG: 'C',
  // same switches as scripts/db-test/run-all.sh (fixtures / maintenance quiet); they only matter for data, not policies
  PGOPTIONS: `${process.env.PGOPTIONS || ''} -c helm.maintenance=off -c helm.allow_hq_mfa_lockout=on -c helm.send_window=off -c helm.allow_purge=on -c helm.r125_gate=off`,
};
const die = (m) => { console.error('gen-0343: ' + m); process.exit(1); };
const run = (cmd, a, input) => {
  const r = spawnSync(cmd, a, { env, input, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status !== 0) die(`${cmd} ${a.join(' ')} failed:\n${r.stderr || r.stdout}`);
  return r.stdout;
};
const psql = (sql) => run('psql', ['-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-f', '-'], sql);

// ---- optional: build the canonical pre-0343 database --------------------------------------------------------------
if (BUILD) {
  run('dropdb', ['--if-exists', DB]); run('createdb', [DB]);
  run('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', join(ROOT, 'supabase/test-harness/00-supabase-shim.sql')]);
  const man = readFileSync(join(ROOT, 'supabase/migrations/MANIFEST'), 'utf8').split('\n');
  for (const line of man) {
    const m = line.match(/^(base|forward)\s+(\S+)/); if (!m) continue;
    if (/\/0343_/.test(m[2])) break;
    run('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1', '-f', join(ROOT, m[2])]);
  }
}
if (psql(`select to_regprocedure('public._r343_wrap(text,text,text,text,text,text,text,text)') is not null;`).trim() === 't')
  die(`database ${DB} already has 0343 - point PGDATABASE at a pre-0343 canonical build (or use --build)`);

// ---- catalog: policies + the functions they may call ---------------------------------------------------------------
const pol = JSON.parse(psql(`set search_path = '';
select coalesce(json_agg(json_build_object('tbl', p.polrelid::regclass::text, 'rel', c.relname, 'pol', p.polname, 'cmd', p.polcmd::text,
         'q', pg_get_expr(p.polqual, p.polrelid), 'c', pg_get_expr(p.polwithcheck, p.polrelid)) order by p.polrelid::regclass::text, p.polname), '[]')
  from pg_policy p join pg_class c on c.oid = p.polrelid;`));
// candidate helpers: every function outside pg_catalog / information_schema, by schema-qualified name. A name is
// wrappable only when EVERY overload is STABLE and returns a single value (never a set).
const fns = JSON.parse(psql(`select coalesce(json_agg(json_build_object('name', n.nspname || '.' || p.proname, 'vol', p.provolatile::text, 'set', p.proretset, 'kind', p.prokind::text)), '[]')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname not in ('pg_catalog', 'information_schema');`));
const byName = new Map();
for (const f of fns) { const a = byName.get(f.name) || []; a.push(f); byName.set(f.name, a); }
const WRAP = new Set([...byName].filter(([, a]) => a.every((f) => f.vol === 's' && !f.set && f.kind === 'f')).map(([n]) => n));
const NONVOL = new Set([...byName].filter(([, a]) => a.every((f) => f.vol !== 'v' && !f.set && f.kind === 'f')).map(([n]) => n));

// ---- tokenizer for pg_get_expr output ------------------------------------------------------------------------------
const isId0 = (ch) => /[A-Za-z_\u0080-￿]/.test(ch);
const isId = (ch) => /[A-Za-z0-9_$\u0080-￿]/.test(ch);
function tokenize(s) {
  const t = []; let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) { let j = i; while (j < s.length && /\s/.test(s[j])) j++; i = j; continue; }
    if (ch === "'" || ((ch === 'E' || ch === 'e') && s[i + 1] === "'" && !(i > 0 && isId(s[i - 1])))) {
      const esc = ch !== "'"; let j = esc ? i + 2 : i + 1;
      for (;;) {
        if (j >= s.length) throw new Error('unterminated string in: ' + s);
        if (esc && s[j] === '\\') { j += 2; continue; }
        if (s[j] === "'") { if (s[j + 1] === "'") { j += 2; continue; } j++; break; }
        j++;
      }
      t.push({ k: 'str', v: s.slice(i, j), a: i, b: j }); i = j; continue;
    }
    if (ch === '"') {
      let j = i + 1;
      for (;;) { if (j >= s.length) throw new Error('unterminated identifier'); if (s[j] === '"') { if (s[j + 1] === '"') { j += 2; continue; } j++; break; } j++; }
      t.push({ k: 'id', v: s.slice(i, j), q: true, a: i, b: j }); i = j; continue;
    }
    if (isId0(ch)) { let j = i + 1; while (j < s.length && isId(s[j])) j++; t.push({ k: 'id', v: s.slice(i, j), a: i, b: j }); i = j; continue; }
    if (/[0-9]/.test(ch)) { const m = s.slice(i).match(/^[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?/); t.push({ k: 'num', v: m[0], a: i, b: i + m[0].length }); i += m[0].length; continue; }
    if (s.startsWith('::', i)) { t.push({ k: '::', v: '::', a: i, b: i + 2 }); i += 2; continue; }
    if ('()[],.;'.includes(ch)) { t.push({ k: ch, v: ch, a: i, b: i + 1 }); i++; continue; }
    let j = i; while (j < s.length && '+-*/<>=~!@#%^&|`?'.includes(s[j])) j++;
    if (j === i) throw new Error(`unexpected character ${JSON.stringify(ch)} in: ${s}`);
    t.push({ k: 'op', v: s.slice(i, j), a: i, b: j }); i = j;
  }
  return t;
}
const up = (tok) => (tok && tok.k === 'id' && !tok.q ? tok.v.toUpperCase() : null);
function matchParen(t, i) {   // t[i] is '(' or '[' -> index of its partner
  const open = t[i].k, close = open === '(' ? ')' : ']'; let d = 0;
  for (let j = i; j < t.length; j++) { if (t[j].k === open) d++; else if (t[j].k === close) { d--; if (d === 0) return j; } }
  throw new Error('unbalanced');
}
// a qualified call starts at i: schema . name ( with no blank between name and '('
function callAt(t, i) {
  if (t[i]?.k !== 'id' || t[i + 1]?.k !== '.' || t[i + 2]?.k !== 'id' || t[i + 3]?.k !== '(' || t[i + 3].a !== t[i + 2].b) return null;
  if (t[i - 1]?.k === '.') return null;
  const name = `${t[i].v}.${t[i + 2].v}`; const close = matchParen(t, i + 3);
  return { name, open: i + 3, close };
}
const MULTI = new Set(['VARYING', 'WITH', 'WITHOUT', 'TIME', 'ZONE', 'PRECISION']);
function skipType(t, j) {   // t[j] = first token after '::' -> index after the type name
  if (t[j]?.k !== 'id') return -1;
  j++;
  if (t[j]?.k === '.' && t[j + 1]?.k === 'id') j += 2;
  while (MULTI.has(up(t[j]))) j++;
  if (t[j]?.k === '(' && t[j].a === t[j - 1].b) { const e = matchParen(t, j); for (let x = j + 1; x < e; x++) if (!['num', ','].includes(t[x].k)) return -1; j = e + 1; }
  while (t[j]?.k === '[' && t[j + 1]?.k === ']') j += 2;
  return j;
}
// true when tokens [a, b) mention no column: only literals, casts, NULL / TRUE / FALSE, ARRAY[...], operators and
// nested calls of non-volatile non-set functions whose own arguments are constant
function constArgs(t, a, b) {
  let j = a;
  while (j < b) {
    const k = t[j];
    if (['str', 'num', ',', ')', ']', 'op'].includes(k.k)) { j++; continue; }
    if (k.k === '[') { j++; continue; }
    if (k.k === '(') { if (up(t[j + 1]) === 'SELECT') return false; j++; continue; }
    if (k.k === '::') { const e = skipType(t, j + 1); if (e < 0) return false; j = e; continue; }
    if (k.k === 'id') {
      const U = up(k);
      if (['NULL', 'TRUE', 'FALSE'].includes(U)) { j++; continue; }
      if (U === 'ARRAY' && t[j + 1]?.k === '[') { j++; continue; }
      const c = callAt(t, j);
      if (c && NONVOL.has(c.name) && constArgs(t, c.open + 1, c.close)) { j = c.close + 1; continue; }
      return false;
    }
    return false;
  }
  return true;
}
// FROM-list position (a function used as a table) - never wrapped
function inFromList(t, i) {
  const p = t[i - 1]; const U = up(p);
  if (U === 'FROM' || U === 'JOIN' || U === 'LATERAL') return true;
  if (p?.k !== ',') return false;
  let d = 0;
  for (let j = i - 1; j >= 0; j--) {
    if (t[j].k === ')' || t[j].k === ']') d++;
    else if (t[j].k === '(' || t[j].k === '[') { if (d === 0) return false; d--; }
    else if (d === 0 && ['WHERE', 'SELECT', 'ON', 'AND', 'OR'].includes(up(t[j]))) return false;
    else if (d === 0 && up(t[j]) === 'FROM') return true;
  }
  return false;
}
// already "( SELECT <call> AS alias)"
function isWrapped(t, i, close) {
  return up(t[i - 1]) === 'SELECT' && t[i - 2]?.k === '(' && up(t[close + 1]) === 'AS' && t[close + 2]?.k === 'id' && t[close + 3]?.k === ')';
}
const stats = { wrapped: new Map(), kept: new Map(), from: 0 };
const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
function rewrite(s) {
  if (s == null) return null;
  const t = tokenize(s); const edits = [];
  for (let i = 0; i < t.length; i++) {
    const c = callAt(t, i); if (!c) continue;
    if (!WRAP.has(c.name)) continue;
    if (isWrapped(t, i, c.close)) continue;
    if (inFromList(t, i)) { stats.from++; continue; }
    if (constArgs(t, c.open + 1, c.close)) { edits.push([t[i].a, t[c.close].b]); bump(stats.wrapped, c.name); i = c.close; }
    else bump(stats.kept, c.name);
  }
  if (!edits.length) return null;
  let out = s;
  for (const [a, b] of edits.reverse()) out = out.slice(0, a) + '(SELECT ' + out.slice(a, b) + ')' + out.slice(b);
  return out;
}
// remove every "( SELECT <qualified call> AS alias)" wrapper -> normalised text (for the same-logic proof)
function unwrapAll(s) {
  if (s == null) return null;
  const t = tokenize(s); const parts = [];
  for (let i = 0; i < t.length; i++) {
    if (t[i].k === '(' && up(t[i + 1]) === 'SELECT') {
      const c = callAt(t, i + 2);
      if (c && up(t[c.close + 1]) === 'AS' && t[c.close + 2]?.k === 'id' && t[c.close + 3]?.k === ')') {
        parts.push(unwrapAll(s.slice(t[i + 2].a, t[c.close].b))); i = c.close + 3; continue;
      }
    }
    parts.push(t[i].v);
  }
  return parts.join(' ');
}
// ---- rewrite every policy ------------------------------------------------------------------------------------------
const changed = [];
for (const p of pol) {
  const nq = rewrite(p.q), nc = rewrite(p.c);
  if (nq == null && nc == null) continue;
  changed.push({ ...p, nq, nc });
}
if (!changed.length) die('no policy to change - is this already a post-0343 database?');

// ---- apply in one rolled-back transaction: read back, fixpoint, md5s ------------------------------------------------
const qi = (s) => '"' + s.replace(/"/g, '""') + '"';
const tag = (s) => { let n = 0; while (s.includes(`$x${n}$`)) n++; return `$x${n}$`; };
const lit = (s) => { if (s == null) return 'null'; const g = tag(s); return g + s + g; };
const alter = (p, q, c) => `alter policy ${qi(p.pol)} on ${p.tbl}${q != null ? ` using (${q})` : ''}${c != null ? ` with check (${c})` : ''};`;
const MD5 = (e) => `md5(regexp_replace(btrim(${e}), '\\s+', ' ', 'g'))`;
const readback = `select coalesce(json_agg(json_build_object('tbl', p.polrelid::regclass::text, 'pol', p.polname,
     'q', pg_get_expr(p.polqual, p.polrelid), 'c', pg_get_expr(p.polwithcheck, p.polrelid),
     'mq', ${MD5('pg_get_expr(p.polqual, p.polrelid)')}, 'mc', ${MD5('pg_get_expr(p.polwithcheck, p.polrelid)')},
     'cmd', p.polcmd::text, 'perm', p.polpermissive, 'roles', p.polroles::text) order by p.polrelid::regclass::text, p.polname), '[]') from pg_policy p;`;
const sql1 = `set search_path = '';\nbegin;\n${readback}\n${changed.map((p) => alter(p, p.nq, p.nc)).join('\n')}\n${readback}\nrollback;\n`;
const [beforeJ, afterJ] = psql(sql1).trim().split('\n').filter((l) => l.startsWith('['));
const key = (r) => r.tbl + '\u0000' + r.pol;
const before = new Map(JSON.parse(beforeJ).map((r) => [key(r), r]));
const after = new Map(JSON.parse(afterJ).map((r) => [key(r), r]));
if (before.size !== after.size) die('policy count changed while altering');
for (const p of changed) {
  const b = before.get(key(p)), a = after.get(key(p));
  if (!a || a.cmd !== b.cmd || a.perm !== b.perm || a.roles !== b.roles) die(`${p.pol} on ${p.tbl}: command / roles / permissive changed`);
  if (unwrapAll(a.q) !== unwrapAll(b.q) || unwrapAll(a.c) !== unwrapAll(b.c)) die(`${p.pol} on ${p.tbl}: logic differs after unwrapping\n  pre : ${b.q} | ${b.c}\n  post: ${a.q} | ${a.c}`);
  if (rewrite(a.q) != null || rewrite(a.c) != null) die(`${p.pol} on ${p.tbl}: something is still unwrapped after the rewrite`);
  Object.assign(p, { pq: b.q, pc: b.c, mpq: b.mq, mpc: b.mc, aq: a.q, ac: a.c, maq: a.mq, mac: a.mc, uq: p.nq != null, uc: p.nc != null });
}
for (const [k, b] of before) if (!changed.find((p) => key(p) === k)) { const a = after.get(k); if (a.mq !== b.mq || a.mc !== b.mc) die('an unchanged policy moved: ' + k); }
// fixpoint: re-applying the read-back text gives the same text (this is the text the migration executes)
const sql2 = `set search_path = '';\nbegin;\n${changed.map((p) => alter(p, p.uq ? p.aq : null, p.uc ? p.ac : null)).join('\n')}\n${readback}\nrollback;\n`;
const fix = new Map(JSON.parse(psql(sql2).trim().split('\n').filter((l) => l.startsWith('['))[0]).map((r) => [key(r), r]));
for (const p of changed) { const f = fix.get(key(p)); if (f.mq !== p.maq || f.mc !== p.mac) die(`${p.pol} on ${p.tbl}: read-back text is not a fixpoint`); }

// ---- counts --------------------------------------------------------------------------------------------------------
const cmdName = { r: 'SELECT', a: 'INSERT', w: 'UPDATE', d: 'DELETE', '*': 'ALL' };
const byCmd = {}; for (const p of changed) byCmd[cmdName[p.cmd]] = (byCmd[cmdName[p.cmd]] || 0) + 1;
const tables = new Set(changed.map((p) => p.tbl));
const wrappedList = [...stats.wrapped].sort((a, b) => b[1] - a[1]);
const hasArea = changed.filter((p) => /public\.has_area\(/.test((p.pq || '') + (p.pc || '')) && /\(SELECT public\.has_area\(|\( SELECT public\.has_area\(/.test((p.aq || '') + (p.ac || ''))).length;
const selAll = changed.filter((p) => p.cmd === 'r' || p.cmd === '*').length;
const summary = `${changed.length} policies on ${tables.size} tables (${Object.entries(byCmd).map(([k, v]) => `${k} ${v}`).join(', ')}; ${selAll} SELECT / ALL); `
  + `${hasArea} of them call has_area; calls wrapped: ${wrappedList.map(([n, c]) => `${n} x${c}`).join(', ')}`;

// ---- emit ----------------------------------------------------------------------------------------------------------
const HEAD = `-- 0343_r148_rls_initplan.sql - R148: RLS speed-up - every per-query helper in a policy runs ONCE per query, not once per row.
-- GENERATED by scripts/gen-0343-rls-initplan.mjs from the canonical database (every MANIFEST migration before 0343).
-- Do not edit by hand: re-run the generator.
--
-- In plain words: many row-level-security rules call small helper functions - has_area('quotes', 'view'),
-- current_org_id(), auth.uid(), is_admin() ... - directly. Postgres then calls them for EVERY row it looks at
-- (has_area alone runs user_role() and current_org_id() inside), so a list of 10,000 tasks took about 4 seconds for a
-- Sales login. Writing the same call as (select has_area(...)) lets Postgres work the answer out ONCE per query and
-- reuse it (an "InitPlan"): same rows, same yes / no, about 1000x faster. This is Supabase's documented
-- "wrap functions in select" RLS optimisation.
--   * ${summary}.
--   * Only calls whose arguments mention no column are wrapped (a call that reads a column of the row is left alone).
--     The helpers are all STABLE (they already see one snapshot per query), so the answer is identical.
--   * ALTER POLICY changes only the expression: name, table, command (SELECT / INSERT / ...), roles and
--     permissive / restrictive stay exactly as they are. No policy is dropped or re-created.
--   * Every policy is guarded: it is changed only when its live expression is still exactly the canonical
--     pre-0343 one; when it already has the 0343 form it is left alone ("already done"); when it differs (drift)
--     a NOTICE "skip ... (differs)" is printed and it is left alone. A failure on one policy never stops the run.
-- Nothing dropped or deleted. No table / column / row / grant changed. Same rules, faster. Safe to run twice.
-- Kept helpers (no app privilege): public._r343_wrap(...) (the guarded ALTER) and public._r343_unwrapped() (lists
-- any policy call that could still be wrapped; the VERIFY counts it).

create or replace function public._r343_md5(p text)
returns text language sql immutable set search_path = '' as $f$
  select pg_catalog.md5(pg_catalog.regexp_replace(pg_catalog.btrim(p), '\\s+', ' ', 'g'));
$f$;

create or replace function public._r343_wrap(p_tbl text, p_pol text, p_pre_q text, p_pre_c text, p_post_q text, p_post_c text,
                                              p_new_q text, p_new_c text)
returns text language plpgsql volatile set search_path = '' as $f$
-- p_pre_* / p_post_* = md5 of the whitespace-normalised expression (deparsed with an empty search_path) before / after 0343
-- (null = the policy has no such clause); p_new_* = the 0343 expression to set (null = this clause is not changed).
declare v_rel oid := pg_catalog.to_regclass(p_tbl); v_q text; v_c text; v_sql text;
begin
  if v_rel is null then raise notice 'r148-0343: skip "%" on % (table not on this database)', p_pol, p_tbl; return 'missing'; end if;
  select public._r343_md5(pg_catalog.pg_get_expr(p.polqual, p.polrelid)), public._r343_md5(pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid))
    into v_q, v_c from pg_catalog.pg_policy p where p.polrelid = v_rel and p.polname = p_pol;
  if not found then raise notice 'r148-0343: skip "%" on % (policy not on this database)', p_pol, p_tbl; return 'missing'; end if;
  if v_q is not distinct from p_post_q and v_c is not distinct from p_post_c then return 'done'; end if;
  if v_q is distinct from p_pre_q or v_c is distinct from p_pre_c then
    raise notice 'r148-0343: skip "%" on % (differs from the canonical rule - left unchanged)', p_pol, p_tbl; return 'differs';
  end if;
  -- the wrap is only "same answer" for a helper that is not VOLATILE and returns one value: check it on THIS database
  if exists (select 1 from pg_catalog.regexp_matches(coalesce(p_new_q, '') || ' ' || coalesce(p_new_c, ''), '\\( SELECT ([a-z_][a-z0-9_]*)\\.([a-z_][a-z0-9_$]*)\\(', 'g') m
              where not exists (select 1 from pg_catalog.pg_proc f join pg_catalog.pg_namespace n on n.oid = f.pronamespace where n.nspname = m[1] and f.proname = m[2])
                 or exists (select 1 from pg_catalog.pg_proc f join pg_catalog.pg_namespace n on n.oid = f.pronamespace
                             where n.nspname = m[1] and f.proname = m[2] and (f.provolatile = 'v' or f.proretset))) then
    raise notice 'r148-0343: skip "%" on % (a helper it calls is missing or VOLATILE / set-returning here - left unchanged)', p_pol, p_tbl; return 'differs';
  end if;
  v_sql := pg_catalog.format('alter policy %I on %s', p_pol, v_rel::regclass);
  if p_new_q is not null then v_sql := v_sql || ' using (' || p_new_q || ')'; end if;
  if p_new_c is not null then v_sql := v_sql || ' with check (' || p_new_c || ')'; end if;
  begin
    execute v_sql;
    select public._r343_md5(pg_catalog.pg_get_expr(p.polqual, p.polrelid)), public._r343_md5(pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid))
      into v_q, v_c from pg_catalog.pg_policy p where p.polrelid = v_rel and p.polname = p_pol;
    if v_q is distinct from p_post_q or v_c is distinct from p_post_c then
      raise exception 'r148-0343: the new expression of "%" on % reads back differently', p_pol, p_tbl;
    end if;
  exception when others then
    raise notice 'r148-0343: skip "%" on % (% - left unchanged)', p_pol, p_tbl, sqlerrm; return 'error';
  end;
  return 'altered';
end $f$;

-- every policy call of a STABLE single-value helper (outside pg_catalog) whose arguments are only literals and that
-- is not yet written as (SELECT ...) - the VERIFY / test count; empty after 0343 on the canonical database
create or replace function public._r343_unwrapped()
returns table(tbl text, pol text, clause text, call text) language sql stable set search_path = '' as $f$
  with f as (
    select pg_catalog.string_agg(distinct pg_catalog.regexp_replace(n.nspname || '.' || p.proname, '([.$])', '\\\\\\1', 'g'), '|') as names
      from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname not in ('pg_catalog', 'information_schema') and p.prokind = 'f'
       and not exists (select 1 from pg_catalog.pg_proc o where o.pronamespace = p.pronamespace and o.proname = p.proname
                         and (o.provolatile <> 's' or o.proretset or o.prokind <> 'f'))
  ), e as (
    select p.polrelid::regclass::text as tbl, p.polname::text as pol, x.clause, x.expr
      from pg_catalog.pg_policy p
      cross join lateral (values ('using', pg_catalog.pg_get_expr(p.polqual, p.polrelid)), ('with check', pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid))) x(clause, expr)
     where x.expr is not null
  )
  select e.tbl, e.pol, e.clause, m.m[1]
    from e, f, lateral pg_catalog.regexp_matches(e.expr,
      '(?<!SELECT )(?<![A-Za-z0-9_."])((?:' || f.names || ')\\((?:(?:''(?:[^'']|'''')*''(?:::[a-z_][a-z0-9_]*(?: [a-z_][a-z0-9_]*)*(?:\\[\\])?)?|-?[0-9][0-9.]*|NULL(?:::[a-z_][a-z0-9_]*)?|true|false)(?:, (?:''(?:[^'']|'''')*''(?:::[a-z_][a-z0-9_]*(?: [a-z_][a-z0-9_]*)*(?:\\[\\])?)?|-?[0-9][0-9.]*|NULL(?:::[a-z_][a-z0-9_]*)?|true|false))*)?\\))', 'g') m(m)
   where f.names is not null;
$f$;

do $r343$ begin
  revoke all on function public._r343_md5(text) from public;
  revoke all on function public._r343_wrap(text, text, text, text, text, text, text, text) from public;
  revoke all on function public._r343_unwrapped() from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public._r343_md5(text) from anon;
    revoke all on function public._r343_wrap(text, text, text, text, text, text, text, text) from anon;
    revoke all on function public._r343_unwrapped() from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public._r343_md5(text) from authenticated;
    revoke all on function public._r343_wrap(text, text, text, text, text, text, text, text) from authenticated;
    revoke all on function public._r343_unwrapped() from authenticated;
  end if;
end $r343$;

-- ---- one guarded block per policy (table, policy, md5 pre USING, md5 pre CHECK, md5 0343 USING, md5 0343 CHECK,
--      new USING or null = unchanged, new CHECK or null = unchanged) ----------------------------------------------
`;
const sq = (s) => (s == null ? 'null' : "'" + s.replace(/'/g, "''") + "'");
const blocks = changed.map((p) => `do $r343$ begin perform public._r343_wrap(${sq(p.tbl)}, ${sq(p.pol)}, ${sq(p.mpq)}, ${sq(p.mpc)}, ${sq(p.maq)}, ${sq(p.mac)},\n  ${p.uq ? lit(p.aq) : 'null'},\n  ${p.uc ? lit(p.ac) : 'null'}); end $r343$;`);
for (const b of blocks) if (/\$r343\$[\s\S]*\$r343\$[\s\S]*\$r343\$/.test(b.replace(/^do \$r343\$|\$r343\$;$/g, ''))) die('dollar tag clash');
const TAIL = `
do $r343$ declare n int; begin
  select count(*) into n from public._r343_unwrapped();
  raise notice 'r148-0343: % policy call(s) could still be wrapped (0 expected on a canonical database)', n;
end $r343$;
`;
const mig = HEAD + blocks.join('\n') + '\n' + TAIL;
const APPLY = `-- APPLY-0343 (R148 RLS speed-up: evaluate has_area / current_org_id / auth.uid ... once per query, not once per row).
-- Run on STAGING first, then production. Safe to run twice. Nothing dropped or deleted. Same rules, faster.
-- A NOTICE "r148-0343: skip ... (differs ...)" means that policy on this database is not the canonical one: it was left
-- exactly as it is (nothing breaks; it simply stays at the old speed). The VERIFY grid at the end must say true.
begin;
${mig.replace(/\s*$/, '\n')}commit;

-- VERIFY every line should say true
select item, ok from (values
  ('01 no policy calls a per-query helper (has_area, current_org_id, auth.uid ...) directly any more', (select count(*) from public._r343_unwrapped()) = 0),
  ('02 has_area in policies now runs once per query', (select count(*) from pg_policies where coalesce(qual, '') || coalesce(with_check, '') ~ 'SELECT (public\\.)?has_area\\(') > 0),
  ('03 the 0343 helpers are not callable by the app', not has_function_privilege('authenticated', 'public._r343_wrap(text,text,text,text,text,text,text,text)', 'execute')
     and not has_function_privilege('anon', 'public._r343_unwrapped()', 'execute') and not has_function_privilege('authenticated', 'public._r343_md5(text)', 'execute'))
) v(item, ok);
`;
const CASES = `-- r148-rls-initplan-0343-cases.sql - GENERATED by scripts/gen-0343-rls-initplan.mjs (do not edit by hand). TEST DATA ONLY:
-- the canonical pre-0343 expression (pre_*) and the 0343 expression (new_*) of every policy 0343 changes, deparsed with
-- an empty search_path. tests/db/r148-rls-initplan-0343.sql loads it into its temp table _x343 (rolled back).
-- ${summary}
insert into _x343(tbl, rel, pol, cmd, pre_q, pre_c, new_q, new_c) values
${changed.map((p) => `(${sq(p.tbl)}, ${sq(p.rel)}, ${sq(p.pol)}, ${sq(p.cmd)}, ${lit(p.pq)}, ${lit(p.pc)}, ${lit(p.aq)}, ${lit(p.ac)})`).join(',\n')};
`;
for (const [n, s] of [['migration', mig], ['apply', APPLY], ['cases', CASES]]) if (/[^\x09\x0a\x0d\x20-\x7e]/.test(s)) die(n + ': non-ASCII text');

const outs = [[OUT_MIG, mig], [OUT_APPLY, APPLY], [OUT_CASES, CASES]];
if (CHECK) {
  let bad = 0;
  for (const [p, s] of outs) if (!existsSync(join(ROOT, p)) || readFileSync(join(ROOT, p), 'utf8') !== s) { console.error('out of date: ' + p); bad++; }
  if (bad) process.exit(1);
  console.log('gen-0343: up to date (' + summary + ')');
} else {
  for (const [p, s] of outs) writeFileSync(join(ROOT, p), s);
  console.log('gen-0343: wrote ' + outs.map(([p]) => p).join(', '));
  console.log('gen-0343: ' + summary);
  if (stats.kept.size) console.log('gen-0343: left alone (an argument reads a column): ' + [...stats.kept].map(([n, c]) => `${n} x${c}`).join(', '));
  if (stats.from) console.log('gen-0343: left alone (used as a table in FROM): ' + stats.from);
}
