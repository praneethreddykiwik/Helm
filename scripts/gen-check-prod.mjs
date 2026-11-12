#!/usr/bin/env node
// gen-check-prod.mjs - builds supabase/CHECK-PROD-MIGRATIONS.sql from supabase/migrations/MANIFEST.
//
// WHY: the owner pastes APPLY-*.sql files into the Supabase SQL editor; those never write the
// helm_schema_migrations ledger, so production has no record of what it has. This generator reads every
// MANIFEST entry, finds the database objects each migration makes (functions by name + argument types,
// tables, views, columns, indexes, policies, triggers, constraints, types, cron jobs, storage buckets,
// kept "__preNNNN" bodies, and the exact body of a re-issued function when the migration is its latest
// author) and writes ONE read-only SELECT that reports, per migration: present / missing / partial.
//
// HOW the object list is derived (regex parser, robust enough for this repo's SQL):
//   - comments are blanked (strings, "identifiers" and $tag$ bodies respected); function bodies are NOT
//     scanned (they run later, not at migration time); DO blocks ARE scanned (they run now).
//   - every create / drop / rename is replayed in MANIFEST order starting from the base snapshot, so an
//     object a later migration drops or renames is not expected, and an object a migration only
//     re-issues (it already existed) is not counted as that migration's evidence. A re-issued function
//     whose LATEST author is migration N is checked by body (md5 of pg_proc.prosrc) for N.
//   - supabase/check-prod-overrides.json: per migration status (optional / skip), a note, objects to
//     ignore, extra objects to check. A migration that makes nothing detectable MUST have an entry
//     there (the generator fails otherwise), so every new migration is either checked or explained.
//
// The output is paste-safe for the Supabase SQL editor: one SELECT, no temp tables, no session settings,
// no psql meta-commands, no DDL / DML; cron.job and storage.buckets are read through query_to_xml only
// when they exist and are readable, so the query never fails on a missing schema.
//
//   node scripts/gen-check-prod.mjs           rewrite supabase/CHECK-PROD-MIGRATIONS.sql
//   node scripts/gen-check-prod.mjs --check   exit 1 if it is out of date vs MANIFEST + migrations
//   node scripts/gen-check-prod.mjs --list N  print the objects found for migration N (debug)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = 'supabase/CHECK-PROD-MIGRATIONS.sql';
const OVR = 'supabase/check-prod-overrides.json';
const MAN = 'supabase/migrations/MANIFEST';
const MAX_SHOWN = 5;                       // missing_objects lists the first few names
const rd = (p) => readFileSync(ROOT + p, 'utf8');

// ---------------------------------------------------------------------------------------------------------
// 1) lexical helpers
// ---------------------------------------------------------------------------------------------------------
const isIdent = (c) => c !== undefined && /[A-Za-z0-9_$]/.test(c);
const DOLLAR = /\$([A-Za-z_][A-Za-z0-9_]*)?\$/y;

// blank comments (same length, newlines kept) so positions map 1:1 onto the original text.
function maskComments(s) {
  const out = s.split('');
  const blank = (a, b) => { for (let k = a; k < b && k < out.length; k++) if (out[k] !== '\n') out[k] = ' '; };
  let i = 0;
  while (i < s.length) {
    const c = s[i], d = s[i + 1];
    if (c === '-' && d === '-') { const e = s.indexOf('\n', i); const end = e < 0 ? s.length : e; blank(i, end); i = end; continue; }
    if (c === '/' && d === '*') {
      let depth = 1, j = i + 2;
      while (j < s.length && depth > 0) {
        if (s[j] === '/' && s[j + 1] === '*') { depth++; j += 2; } else if (s[j] === '*' && s[j + 1] === '/') { depth--; j += 2; } else j++;
      }
      blank(i, j); i = j; continue;
    }
    if (c === "'") {
      const esc = (s[i - 1] === 'E' || s[i - 1] === 'e') && !isIdent(s[i - 2]);
      let j = i + 1;
      while (j < s.length) {
        if (esc && s[j] === '\\') { j += 2; continue; }
        if (s[j] === "'") { if (s[j + 1] === "'") { j += 2; continue; } break; }
        j++;
      }
      i = j + 1; continue;
    }
    if (c === '"') { let j = i + 1; while (j < s.length) { if (s[j] === '"') { if (s[j + 1] === '"') { j += 2; continue; } break; } j++; } i = j + 1; continue; }
    if (c === '$' && !isIdent(s[i - 1])) {
      DOLLAR.lastIndex = i; const m = DOLLAR.exec(s);
      if (m) {
        const tag = m[0], start = i + tag.length, end = s.indexOf(tag, start);   // PG ends a $tag$ at the first match
        if (end < 0) { i = s.length; continue; }
        const inner = maskComments(s.slice(start, end));
        for (let k = 0; k < inner.length; k++) out[start + k] = inner[k];
        i = end + tag.length; continue;
      }
    }
    i++;
  }
  return out.join('');
}

// index just past the ')' matching the '(' at position i (strings / quoted identifiers / $tag$ skipped).
function closeParen(s, i) {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === "'") { j++; while (j < s.length && !(s[j] === "'" && s[j + 1] !== "'")) { if (s[j] === "'") j++; j++; } continue; }
    if (c === '"') { j++; while (j < s.length && s[j] !== '"') j++; continue; }
    if (c === '$' && !isIdent(s[j - 1])) {
      DOLLAR.lastIndex = j; const m = DOLLAR.exec(s);
      if (m) { const e = s.indexOf(m[0], j + m[0].length); if (e < 0) return -1; j = e + m[0].length - 1; continue; }
    }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return j + 1; }
  }
  return -1;
}

// split on commas at paren depth 0 (quotes ignored on purpose: callers only need names, a stray comma
// inside a default value only produces a fragment that matches nothing).
function splitTop(s) {
  const parts = []; let depth = 0, last = 0;
  for (let j = 0; j < s.length; j++) {
    if (s[j] === '(') depth++; else if (s[j] === ')') depth--;
    else if (s[j] === ',' && depth === 0) { parts.push(s.slice(last, j)); last = j + 1; }
  }
  parts.push(s.slice(last));
  return parts;
}

// end of the statement starting at i: first ';' at paren depth 0 (quotes ignored, see splitTop).
function stmtEnd(s, i) {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === '(') depth++; else if (s[j] === ')') depth = Math.max(0, depth - 1);
    else if (s[j] === ';' && depth === 0) return j;
  }
  return s.length;
}

const ID = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)`;
const QN = String.raw`${ID}(?:\s*\.\s*${ID})?(?![A-Za-z0-9_$]|\s*\.)`;
const RESERVED_AS_NAME = new Set(['on', 'if', 'not', 'exists', 'only', 'concurrently', 'table', 'function', 'select', 'as', 'to', 'from']);
const unq = (x) => (x.startsWith('"') ? x.slice(1, -1).replace(/""/g, '"') : x.toLowerCase());
const validName = (x) => !!x && !RESERVED_AS_NAME.has(x) && !/[%|'\s]/.test(x) && x.length <= 63;
function qname(raw, defSchema = 'public') {
  const parts = raw.match(new RegExp(ID, 'g')).map(unq);
  const q = parts.length === 2 ? { schema: parts[0], name: parts[1] } : { schema: defSchema, name: parts[0] };
  return validName(q.name) && validName(q.schema) ? q : null;
}
// SQL text for a (possibly) qualified name, quoted only when needed.
const qi = (x) => (/^[a-z_][a-z0-9_$]*$/.test(x) ? x : '"' + x.replace(/"/g, '""') + '"');
const rel = (q) => qi(q.schema) + '.' + qi(q.name);

// ---------------------------------------------------------------------------------------------------------
// 2) argument types -> normalised signature
// ---------------------------------------------------------------------------------------------------------
const ALIAS = {
  int: 'integer', int4: 'integer', integer: 'integer', int8: 'bigint', int2: 'smallint', bool: 'boolean',
  varchar: 'character varying', 'character varying': 'character varying', char: 'character', bpchar: 'character',
  timestamptz: 'timestamp with time zone', timestamp: 'timestamp without time zone',
  'timestamp without time zone': 'timestamp without time zone', 'timestamp with time zone': 'timestamp with time zone',
  timetz: 'time with time zone', time: 'time without time zone', float8: 'double precision', float4: 'real',
  float: 'double precision', decimal: 'numeric', dec: 'numeric',
};
const MULTI = /^(double\s+precision|character\s+varying|bit\s+varying|timestamp(?:\s*\(\d+\))?\s+with(?:out)?\s+time\s+zone|time(?:\s*\(\d+\))?\s+with(?:out)?\s+time\s+zone|interval\s+\w+(?:\s+to\s+\w+)?)/i;
function normType(t) {
  let x = t.trim().replace(/\s+/g, ' ');
  let arr = '';
  while (/\[\s*\d*\s*\]$/.test(x)) { arr += '[]'; x = x.replace(/\s*\[\s*\d*\s*\]$/, ''); }
  if (/\s+array$/i.test(x)) { arr += '[]'; x = x.replace(/\s+array$/i, ''); }
  x = x.replace(/\s*\([^)]*\)/g, '');                                      // typmods: numeric(12,2) -> numeric
  x = x.replace(/^(?:"public"|public)\s*\.\s*/i, '').replace(/^pg_catalog\s*\.\s*/i, '');   // resolved via search_path
  if (!x.startsWith('"')) x = x.toLowerCase();
  return (ALIAS[x] || x) + arr;
}
const MULTI_ALL = new RegExp(MULTI.source + String.raw`\s*(?:\[\s*\d*\s*\]\s*)*$`, 'i');
// a type string must be safe for to_regtype() on every Postgres version (older ones raise on bad syntax)
const MULTI_OK = new Set(['double precision', 'character varying', 'bit varying', 'timestamp with time zone',
  'timestamp without time zone', 'time with time zone', 'time without time zone']);
const TYPE_OK = (t) => /^(?:"[^"]+"|[a-z_][a-z0-9_]*)(?:\.(?:"[^"]+"|[a-z_][a-z0-9_]*))?(?:\[\])*$/.test(t) || MULTI_OK.has(t.replace(/(\[\])+$/, ''));
// returns { types: [...] } (input args only) or null when the list cannot be read safely.
function parseArgs(inner) {
  if (!inner.trim()) return { types: [] };
  const types = [];
  for (let a of splitTop(inner)) {
    a = a.trim().replace(/\s+/g, ' ');
    a = a.replace(/\s+(?:default\b|=)[\s\S]*$/i, '');
    let mode = 'in';
    const mm = a.match(/^(in|out|inout|variadic)\s+/i);
    if (mm) { mode = mm[1].toLowerCase(); a = a.slice(mm[0].length); }
    if (mode === 'out') continue;
    let type = a;
    if (!MULTI_ALL.test(a)) { const m2 = a.match(new RegExp(`^(${ID})\\s+(.+)$`)); if (m2) type = m2[2]; }
    if (/%type/i.test(type)) return null;
    const n = normType(type);
    if (!TYPE_OK(n)) return null;
    types.push(n);
  }
  return { types };
}

// ---------------------------------------------------------------------------------------------------------
// 3) parse one file into an ordered event list
// ---------------------------------------------------------------------------------------------------------
// events (replayed by build() in file order): create {obj} | drop {key} | rename {fromKey, obj} | dropRel / renameRel
// (a table or view and everything on it) | dropFnName (every overload) | dropAllPol / dropPolName (dynamic policy drops)
// | lit (a function named in a string literal: its body may have been changed by dynamic SQL) | globalTouch
function keyOf(o) {
  switch (o.kind) {
    case 'fn': return `fn ${rel(o)}(${o.types.join(',')})`;
    case 'col': return `column ${rel(o.rel)}.${qi(o.name)}`;
    case 'pol': return `policy ${o.name} on ${rel(o.rel)}`;
    case 'trg': return `trigger ${o.name} on ${rel(o.rel)}`;
    case 'con': return `constraint ${o.name} on ${rel(o.rel)}`;
    case 'idx': return `index ${rel(o)}`;
    case 'tbl': return `table ${rel(o)}`;
    case 'view': return `view ${rel(o)}`;
    case 'seq': return `seq ${rel(o)}`;
    case 'type': return `type ${rel(o)}`;
    case 'schema': return `schema ${qi(o.name)}`;
    case 'cron': return `cron ${o.name}`;
    case 'bucket': return `bucket ${o.name}`;
    case 'pre': return `pre *${o.name}`;
    case 'pub': return `publication ${o.name} has ${rel(o.rel)}`;
    case 'marker': return `marker ${rel(o)}(${o.types.join(',')}) ${o.text}`;
    case 'polexpr': return `polexpr ${o.name} on ${rel(o.rel)} ${o.text}`;
    case 'exec': return `execute ${o.role} ${rel(o)}(${o.types.join(',')})`;
    default: throw new Error('kind ' + o.kind);
  }
}

export function parseFile(src) {
  const C0 = maskComments(src);
  const ev = [];
  const bodies = [];                                    // [start, end) ranges of function bodies (not scanned)
  // ---- functions (header + body) ----
  const FH = new RegExp(String.raw`\bcreate\s+(?:or\s+replace\s+)?function\s+(${QN})\s*\(`, 'gi');
  for (let m; (m = FH.exec(C0));) {
    if (bodies.some(([a, b]) => m.index >= a && m.index < b)) continue;
    const open = m.index + m[0].length - 1, close = closeParen(C0, open);
    if (close < 0) continue;
    const q = qname(m[1]);
    const args = parseArgs(C0.slice(open + 1, close - 1));
    // body: first $tag$ after the header and before the statement's ';'
    let j = close, body = null, lang = null;
    while (j < C0.length) {
      const c = C0[j];
      if (c === ';') break;
      if (c === "'") { j++; while (j < C0.length && !(C0[j] === "'" && C0[j + 1] !== "'")) { if (C0[j] === "'") j++; j++; } j++; continue; }
      if (c === '$' && !isIdent(C0[j - 1])) {
        DOLLAR.lastIndex = j; const d = DOLLAR.exec(C0);
        if (d) {
          const bs = j + d[0].length, be = src.indexOf(d[0], bs);
          if (be < 0) break;
          body = { start: bs, end: be, text: src.slice(bs, be) };
          bodies.push([j, be + d[0].length]);
          j = be + d[0].length;
          const tail = C0.slice(j, stmtEnd(C0, j));
          const lm = tail.match(/\blanguage\s+([a-z]+)/i) || C0.slice(close, bs).match(/\blanguage\s+([a-z]+)/i);
          lang = lm ? lm[1].toLowerCase() : null;
          break;
        }
      }
      j++;
    }
    if (q && !args) ev.push({ pos: m.index, op: 'lit', name: q.name });   // unreadable argument list: its body is unknown
    if (!q || !args) continue;
    ev.push({ pos: m.index, op: 'create', obj: { kind: 'fn', schema: q.schema, name: q.name, types: args.types },
      md5: body && (lang === 'plpgsql' || lang === 'sql') ? createHash('md5').update(body.text, 'utf8').digest('hex') : null, body: body ? body.text : '' });
  }
  // DDL outside function bodies
  const C = C0.split('');
  for (const [a, b] of bodies) for (let k = a; k < b; k++) if (C[k] !== '\n') C[k] = ' ';
  const S = C.join('');
  const each = (re, fn) => { for (let m; (m = re.exec(S));) fn(m); };
  const R = (x) => new RegExp(x, 'gi');

  each(R(String.raw`\bcreate\s+(?:(?:global|local)\s+)?(temp|temporary|unlogged\s+)?\s*table\s+(?:if\s+not\s+exists\s+)?(${QN})`), (m) => {
    if (m[1] && /^temp/i.test(m[1])) return;
    const q = qname(m[2]); if (q) ev.push({ pos: m.index, op: 'create', obj: { kind: 'tbl', ...q } });
  });
  each(R(String.raw`\bcreate\s+(?:or\s+replace\s+)?(?:materialized\s+)?view\s+(?:if\s+not\s+exists\s+)?(${QN})`), (m) => {
    const q = qname(m[1]); if (q) ev.push({ pos: m.index, op: 'create', obj: { kind: 'view', ...q } });
  });
  each(R(String.raw`\bcreate\s+sequence\s+(?:if\s+not\s+exists\s+)?(${QN})`), (m) => {
    const q = qname(m[1]); if (q) ev.push({ pos: m.index, op: 'create', obj: { kind: 'seq', ...q } });
  });
  each(R(String.raw`\bcreate\s+(?:type|domain)\s+(${QN})\s+as\b`), (m) => {
    const q = qname(m[1]); if (q) ev.push({ pos: m.index, op: 'create', obj: { kind: 'type', ...q } });
  });
  each(R(String.raw`\bcreate\s+schema\s+(?:if\s+not\s+exists\s+)?(${ID})`), (m) => {
    const n = unq(m[1]); if (validName(n) && n !== 'authorization') ev.push({ pos: m.index, op: 'create', obj: { kind: 'schema', name: n } });
  });
  each(R(String.raw`\bcreate\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?(${ID})\s+on\s+(?:only\s+)?(${QN})`), (m) => {
    const n = unq(m[1]), t = qname(m[2]);
    if (validName(n) && t) ev.push({ pos: m.index, op: 'create', obj: { kind: 'idx', schema: t.schema, name: n, rel: t } });
  });
  each(R(String.raw`\bcreate\s+policy\s+(${ID})\s+on\s+(${QN})`), (m) => {
    const n = unq(m[1]), t = qname(m[2]);
    if (n && !/[%|']/.test(n) && t) ev.push({ pos: m.index, op: 'create', obj: { kind: 'pol', name: n, rel: t } });
  });
  each(R(String.raw`\bcreate\s+(?:or\s+replace\s+)?(?:constraint\s+)?trigger\s+(${ID})\s+(?:before|after|instead\s+of)\b[^;]{0,600}?\bon\s+(${QN})`), (m) => {
    const n = unq(m[1]), t = qname(m[2]);
    if (validName(n) && t) ev.push({ pos: m.index, op: 'create', obj: { kind: 'trg', name: n, rel: t } });
  });
  // alter table ... (add / drop / rename column, add / drop / rename constraint, rename table)
  each(R(String.raw`\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(${QN})\s+`), (m) => {
    const t = qname(m[1]); if (!t) return;
    const body = S.slice(m.index + m[0].length, stmtEnd(S, m.index + m[0].length));
    for (let act of splitTop(body)) {
      act = act.trim().replace(/\s+/g, ' ');
      let x;
      if ((x = act.match(new RegExp(`^rename\\s+to\\s+(${ID})`, 'i')))) {
        const n = unq(x[1]); if (validName(n)) ev.push({ pos: m.index, op: 'renameRel', from: t, to: { schema: t.schema, name: n } });
      } else if ((x = act.match(new RegExp(`^rename\\s+constraint\\s+(${ID})\\s+to\\s+(${ID})`, 'i')))) {
        ev.push({ pos: m.index, op: 'rename', fromKey: keyOf({ kind: 'con', name: unq(x[1]), rel: t }), obj: { kind: 'con', name: unq(x[2]), rel: t } });
      } else if ((x = act.match(new RegExp(`^rename\\s+(?:column\\s+)?(${ID})\\s+to\\s+(${ID})`, 'i')))) {
        ev.push({ pos: m.index, op: 'rename', fromKey: keyOf({ kind: 'col', name: unq(x[1]), rel: t }), obj: { kind: 'col', name: unq(x[2]), rel: t } });
      } else if ((x = act.match(new RegExp(`^add\\s+constraint\\s+(${ID})`, 'i')))) {
        const n = unq(x[1]); if (validName(n)) ev.push({ pos: m.index, op: 'create', obj: { kind: 'con', name: n, rel: t } });
      } else if ((x = act.match(new RegExp(`^drop\\s+constraint\\s+(?:if\\s+exists\\s+)?(${ID})`, 'i')))) {
        ev.push({ pos: m.index, op: 'drop', key: keyOf({ kind: 'con', name: unq(x[1]), rel: t }) });
      } else if ((x = act.match(new RegExp(`^add\\s+(?:column\\s+)?(?:if\\s+not\\s+exists\\s+)?(${ID})\\s+\\S`, 'i')))) {
        const n = unq(x[1]);
        if (validName(n) && !/^(constraint|primary|foreign|unique|check|exclude|column)$/i.test(n)) ev.push({ pos: m.index, op: 'create', obj: { kind: 'col', name: n, rel: t } });
      } else if ((x = act.match(new RegExp(`^drop\\s+(?:column\\s+)?(?:if\\s+exists\\s+)?(${ID})`, 'i')))) {
        const n = unq(x[1]);
        if (validName(n) && !/^(constraint|default|not|identity|expression)$/i.test(n)) ev.push({ pos: m.index, op: 'drop', key: keyOf({ kind: 'col', name: n, rel: t }) });
      }
    }
  });
  // drops
  each(R(String.raw`\bdrop\s+(table|view|materialized\s+view|sequence|type|domain|index)\s+(?:concurrently\s+)?(?:if\s+exists\s+)?(${QN}(?:\s*,\s*${QN})*)`), (m) => {
    const kind = /table/i.test(m[1]) ? 'tbl' : /view/i.test(m[1]) ? 'view' : /seq/i.test(m[1]) ? 'seq' : /index/i.test(m[1]) ? 'idx' : 'type';
    for (const raw of splitTop(m[2])) {
      const q = qname(raw.trim()); if (!q) continue;
      if (kind === 'tbl' || kind === 'view') ev.push({ pos: m.index, op: 'dropRel', rel: q, kind });
      else ev.push({ pos: m.index, op: 'drop', key: keyOf({ kind, ...q }) });
    }
  });
  each(R(String.raw`\bdrop\s+function\s+(?:if\s+exists\s+)?`), (m) => {
    let j = m.index + m[0].length;
    const end = stmtEnd(S, j);
    while (j < end) {
      const nm = new RegExp(`^\\s*(${QN})\\s*`).exec(S.slice(j, end)); if (!nm) break;
      const q = qname(nm[1]); j += nm[0].length;
      if (S[j] === '(') {
        const c = closeParen(S, j); if (c < 0) break;
        const a = parseArgs(S.slice(j + 1, c - 1)); j = c;
        if (q && a) ev.push({ pos: m.index, op: 'drop', key: keyOf({ kind: 'fn', ...q, types: a.types }) });
      } else if (q) ev.push({ pos: m.index, op: 'dropFnName', schema: q.schema, name: q.name });
      const sep = /^\s*,/.exec(S.slice(j, end)); if (!sep) break; j += sep[0].length;
    }
  });
  each(R(String.raw`\bdrop\s+(policy|trigger)\s+(?:if\s+exists\s+)?(${ID})\s+on\s+(${QN})`), (m) => {
    const t = qname(m[3]); if (!t) return;
    ev.push({ pos: m.index, op: 'drop', key: keyOf({ kind: /pol/i.test(m[1]) ? 'pol' : 'trg', name: unq(m[2]), rel: t }) });
  });
  // renames
  each(R(String.raw`\balter\s+function\s+(${QN})\s*\(`), (m) => {
    const open = m.index + m[0].length - 1, c = closeParen(S, open); if (c < 0) return;
    const r2 = new RegExp(`^\\s*rename\\s+to\\s+(${ID})`, 'i').exec(S.slice(c, c + 200)); if (!r2) return;
    const q = qname(m[1]), a = parseArgs(S.slice(open + 1, c - 1)), n = unq(r2[1]);
    if (q && a && validName(n)) ev.push({ pos: m.index, op: 'rename', fromKey: keyOf({ kind: 'fn', ...q, types: a.types }), obj: { kind: 'fn', schema: q.schema, name: n, types: a.types } });
  });
  each(R(String.raw`\balter\s+index\s+(?:if\s+exists\s+)?(${QN})\s+rename\s+to\s+(${ID})`), (m) => {
    const q = qname(m[1]), n = unq(m[2]); if (!q || !validName(n)) return;
    ev.push({ pos: m.index, op: 'rename', fromKey: keyOf({ kind: 'idx', ...q }), obj: { kind: 'idx', schema: q.schema, name: n } });
  });
  each(R(String.raw`\balter\s+(policy|trigger)\s+(${ID})\s+on\s+(${QN})\s+rename\s+to\s+(${ID})`), (m) => {
    const t = qname(m[3]); if (!t) return; const kind = /pol/i.test(m[1]) ? 'pol' : 'trg';
    ev.push({ pos: m.index, op: 'rename', fromKey: keyOf({ kind, name: unq(m[2]), rel: t }), obj: { kind, name: unq(m[4]), rel: t } });
  });
  each(R(String.raw`\balter\s+publication\s+(${ID})\s+(add|drop)\s+table\s+(?:only\s+)?(${QN}(?:\s*,\s*${QN})*)`), (m) => {
    for (const raw of splitTop(m[3])) {
      const t = qname(raw.trim()); if (!t) continue;
      const obj = { kind: 'pub', name: unq(m[1]), rel: t };
      ev.push(/add/i.test(m[2]) ? { pos: m.index, op: 'create', obj } : { pos: m.index, op: 'drop', key: keyOf(obj) });
    }
  });
  // cron jobs + storage buckets (need the literal strings, so these read the comment-blanked text)
  each(R(String.raw`\bcron\.schedule\s*\(\s*'([^']+)'\s*,\s*'[^']*'\s*,`), (m) => ev.push({ pos: m.index, op: 'create', obj: { kind: 'cron', name: m[1] } }));
  each(R(String.raw`\bcron\.unschedule\s*\(\s*'([^']+)'\s*\)`), (m) => ev.push({ pos: m.index, op: 'drop', key: keyOf({ kind: 'cron', name: m[1] }) }));
  each(R(String.raw`\binsert\s+into\s+storage\.buckets\s*\(([^)]*)\)\s*values\s*`), (m) => {
    const cols = m[1].split(',').map((x) => x.trim().toLowerCase()), at = cols.indexOf('id');
    if (at < 0) return;
    let j = m.index + m[0].length;
    for (;;) {
      if (S[j] !== '(') break;
      const c = closeParen(S, j); if (c < 0) break;
      const vals = splitTop(S.slice(j + 1, c - 1)).map((x) => x.trim());
      const v = /^'([^']+)'$/.exec(vals[at] || '');
      if (v) ev.push({ pos: m.index, op: 'create', obj: { kind: 'bucket', name: v[1] } });
      const sep = /^\s*,\s*/.exec(S.slice(c)); if (!sep) break; j = c + sep[0].length;
    }
  });
  // dynamic SQL the parser cannot read exactly (see build()):
  //   drop policy if exists %I on public.t   -> every policy on public.t is dropped
  //   drop policy if exists p on public.%I   -> policy p is dropped wherever it is
  each(R(String.raw`\bdrop\s+policy\s+(?:if\s+exists\s+)?%[IsL]\s+on\s+(${QN})`), (m) => {
    const t = qname(m[1]); if (t) ev.push({ pos: m.index, op: 'dropAllPol', rel: t });
  });
  each(R(String.raw`\bdrop\s+policy\s+(?:if\s+exists\s+)?(${ID})\s+on\s+(?:${ID}\s*\.\s*)?%[IsL]`), (m) => ev.push({ pos: m.index, op: 'dropPolName', name: unq(m[1]) }));
  //   string literals that name a function: 'f', 'public.f', 'public.f(uuid)' - used by rename-and-wrap loops and
  //   by body patchers (pg_get_functiondef + replace), which change functions without a create statement
  const dynRename = /\brename\s+to\s+(?:%[Is]|'\s*\|\|)/i.test(C0);
  const dynPatch = /\bpg_get_functiondef\b/i.test(C0) || /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:public\s*\.\s*)?%[Is]/i.test(C0);
  if (dynRename || dynPatch) {
    each(/'(?:public\s*\.\s*)?([a-z_][a-z0-9_]*)(?:\s*\([^'()]*\))?'/g, (m) => ev.push({ pos: m.index, op: 'lit', name: m[1] }));
  }
  //   global body patchers: a loop over pg_proc that rewrites every body matching a name pattern or containing a
  //   text (pg_get_functiondef(r.oid) + replace) -> every function whose name / body matches is no longer known
  const gp = /\bpg_get_functiondef\s*\(\s*(?!')/i.exec(S);
  if (gp && /\bpg_proc\b/i.test(S)) {
    const needles = [], names = [], consts = {};
    // only the filters of the loop: proname like / ~ patterns, and texts searched for in prosrc
    each(/\b([a-z_][a-z0-9_]*)\s+constant\s+text\s*:=\s*(?:'((?:[^']|'')*)'|\$([A-Za-z_]\w*)\$([\s\S]*?)\$\3\$)/gi,
      (m) => { consts[m[1].toLowerCase()] = m[2] !== undefined ? m[2].replace(/''/g, "'") : m[4]; });
    each(/\bposition\s*\(\s*(?:'((?:[^']|'')*)'|([a-z_][a-z0-9_]*))\s+in\s+[^;]{0,80}?\bprosrc\b/gi, (m) => {
      const t = m[1] !== undefined ? m[1].replace(/''/g, "'") : consts[m[2].toLowerCase()];
      if (t && t.length >= 4) needles.push(t);
    });
    each(/\bprosrc\s+i?like\s+'%((?:[^%']|'')+)%'/gi, (m) => needles.push(m[1].replace(/''/g, "'")));
    each(/\bproname\s+(?:i?like)\s+'([^']+)'/gi, (m) => names.push(new RegExp('^' + m[1].replace(/[.*+?^${}()|[\]]/g, '\\$&').replace(/\\\\_/g, '_').replace(/%/g, '.*').replace(/(?<!\\)_/g, '.') + '$')));
    each(/\bproname\s*~\*?\s*'([^']+)'/gi, (m) => { try { names.push(new RegExp(m[1].replace(/''/g, "'"))); } catch { /* not a JS regex */ } });
    ev.push({ pos: gp.index, op: 'globalTouch', needles, names });
  }
  ev.sort((a, b) => a.pos - b.pos);
  return { ev, text: C0 };
}

// ---------------------------------------------------------------------------------------------------------
// 4) MANIFEST + overrides + replay
// ---------------------------------------------------------------------------------------------------------
export function readManifest() {
  const list = [];
  for (const line of rd(MAN).split('\n')) {
    const m = line.match(/^(base|forward)\s+(\S+)/); if (!m) continue;
    const file = m[2].split('/').pop().replace(/\.sql$/, '');
    list.push({ scope: m[1], path: m[2], id: file, num: m[1] === 'base' ? 'base' : file.slice(0, 4), text: rd(m[2]) });
  }
  return list;
}
function readOverrides(migs, raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith('_')) continue;
    const hit = migs.filter((x) => x.id === k || x.num === k);
    if (hit.length !== 1) throw new Error(`${OVR}: "${k}" does not name exactly one MANIFEST entry`);
    if (v.status && !['optional', 'skip'].includes(v.status)) throw new Error(`${OVR}: ${k}: status must be optional or skip`);
    out[hit[0].id] = v;
  }
  return out;
}

const relOfKey = (o) => (o.rel ? `${rel(o.rel)}` : null);
// migs: [{ id, num, text }] in apply order; overrides: the parsed check-prod-overrides.json
export function build({ migs = readManifest(), overrides = existsSync(ROOT + OVR) ? JSON.parse(rd(OVR)) : {}, loose = false } = {}) {
  const ovr = readOverrides(migs, overrides);
  const live = new Map();          // key -> { obj, by (introducing migration id), last (latest author), md5 }
  const made = new Map();          // migration id -> number of objects it created (any, even if superseded)
  for (const mg of migs) {
    const { ev, text } = parseFile(mg.text);
    let n = 0;
    const named = new Set(), mine = new Set(), gone = new Map();
    const del = (k) => { const v = live.get(k); if (v && !gone.has(k)) gone.set(k, v); live.delete(k); };
    const fnsNamed = (name) => [...live].filter(([, v]) => v.obj.kind === 'fn' && v.obj.schema === 'public' && v.obj.name === name);
    for (const e of ev) {
      if (e.op === 'lit') {
        named.add(e.name);
        // a body patcher rewrote it in place: its body is no longer the last create's body
        // (a rename-and-wrap loop may also re-create it with dynamic SQL): the last parsed body is not the live one
        for (const [, v] of fnsNamed(e.name)) { v.md5 = null; v.last = mg.id; }
        continue;
      }
      if (e.op === 'create' && e.obj.kind === 'fn' && e.obj.schema === 'public' && named.has(e.obj.name)) {
        // rename-and-wrap with a NEW argument list: the old overload was renamed to *__preNNNN by dynamic SQL
        const key = keyOf(e.obj);
        for (const [k] of fnsNamed(e.obj.name)) if (k !== key && !mine.has(k)) live.delete(k);
      }
      if (e.op === 'globalTouch') {
        for (const [, v] of live) if (v.obj.kind === 'fn' && v.md5 && (e.names.some((r) => r.test(v.obj.name)) || e.needles.some((t) => (v.body || "").includes(t)))) { v.md5 = null; v.last = mg.id; }
        continue;
      }
      if (e.op === 'dropAllPol') { for (const [k, v] of live) if (v.obj.kind === 'pol' && rel(v.obj.rel) === rel(e.rel)) del(k); continue; }
      if (e.op === 'dropPolName') { for (const [k, v] of live) if (v.obj.kind === 'pol' && v.obj.name === e.name) del(k); continue; }
      if (e.op === 'create' && e.obj.rel && e.obj.rel.schema === 'public' && e.obj.kind !== 'pub'
          && !live.has(keyOf({ kind: 'tbl', ...e.obj.rel })) && !live.has(keyOf({ kind: 'view', ...e.obj.rel }))) continue;   // on a table no migration makes (guarded by to_regclass): nothing to expect
      if (e.op === 'create') {
        const key = keyOf(e.obj); n++; mine.add(key);
        const cur = live.get(key);
        if (cur) { cur.last = mg.id; if (e.md5 !== undefined) { cur.md5 = e.md5; cur.body = e.body; } }
        // dropped / renamed away earlier in THIS migration and made again (drop + create, rename-and-wrap):
        // a re-issue - the name existed before this migration, so it is no evidence of it
        else live.set(key, { obj: e.obj, by: gone.has(key) ? gone.get(key).by : mg.id, last: mg.id, md5: e.md5, body: e.body || '' });
      } else if (e.op === 'drop') del(e.key);
      else if (e.op === 'dropFnName') { for (const [k, v] of live) if (v.obj.kind === 'fn' && v.obj.schema === e.schema && v.obj.name === e.name) del(k); }
      else if (e.op === 'rename') {
        const cur = live.get(e.fromKey); del(e.fromKey);
        const key = keyOf(e.obj);
        if (!live.has(key)) live.set(key, { obj: e.obj, by: mg.id, last: mg.id, md5: cur ? cur.md5 : null, body: cur ? cur.body : '' });
      } else if (e.op === 'dropRel' || e.op === 'renameRel') {
        const r0 = rel(e.op === 'dropRel' ? e.rel : e.from);
        const tk = keyOf({ kind: e.op === 'dropRel' ? e.kind : 'tbl', ...(e.op === 'dropRel' ? e.rel : e.from) });
        const moved = [];
        for (const [k, v] of live) if (k === tk || relOfKey(v.obj) === r0 || (v.obj.kind === 'idx' && v.obj.rel && rel(v.obj.rel) === r0)) { del(k); moved.push(v); }
        if (e.op === 'renameRel') for (const v of moved) {
          const o = v.obj.rel ? { ...v.obj, rel: e.to } : { ...v.obj, ...e.to };
          live.set(keyOf(o), { ...v, obj: o, by: mg.id });
        }
      }
    }
    // kept bodies: "<name>__pre<NNNN>" for this migration's own number (most are made with dynamic SQL)
    if (mg.num !== 'base' && new RegExp(`__pre${mg.num}(?![0-9A-Za-z])`).test(text)) {
      const key = keyOf({ kind: 'pre', name: `__pre${mg.num}` });
      if (!live.has(key)) live.set(key, { obj: { kind: 'pre', name: `__pre${mg.num}` }, by: mg.id, last: mg.id }); n++;
    }
    made.set(mg.id, n);
  }
  // evidence per migration: what it introduced and still exists + the body of what it re-issued last
  const evid = new Map(migs.map((m) => [m.id, []]));
  for (const [key, v] of live) {
    evid.get(v.by).push({ key, obj: v.obj, body: false });
    if (v.obj.kind === 'fn' && v.last !== v.by && v.md5) evid.get(v.last).push({ key: 'body ' + key.slice(3), obj: v.obj, body: true, md5: v.md5 });
  }
  const rows = [], problems = [], warnings = [];
  for (const mg of migs) {
    const o = { ...(ovr[mg.id] || {}) };
    const ignore = new Set(o.ignore || []);
    for (const k of ignore) if (!evid.get(mg.id).some((x) => x.key === k)) warnings.push(`${OVR}: ${mg.id}: ignore "${k}" is no longer an object of this migration (stale entry, remove it)`);
    let list = evid.get(mg.id).filter((x) => !ignore.has(x.key));
    for (const k of o.add || []) list.push(objFromLabel(k, mg.id));
    if (o.status === 'skip') list = [];
    if (!list.length && !o.status) {
      if (made.get(mg.id)) { o.status = 'superseded'; o.note = o.note || 'everything it made was re-issued or removed by later migrations (checked there)'; }
      else if (!o.note) problems.push(`${mg.id}: makes nothing detectable - add an entry to ${OVR} (a "note" + status "skip" / "optional", or "add" objects to check)`);
    }
    rows.push({ mg, o, list });
  }
  if (problems.length && !loose) throw new Error(problems.join('\n'));
  return { migs, rows, live, problems, warnings };
}

// "fn public.f(uuid,text)" / "table public.t" / "column public.t.c" / "index public.i" / "policy NAME on public.t" ...
function objFromLabel(label, who) {
  let m;
  const bad = () => { throw new Error(`${OVR}: ${who}: cannot read "${label}"`); };
  if ((m = label.match(/^fn ([^(]+)\((.*)\)$/))) { const q = qname(m[1]); const a = parseArgs(m[2]); if (!q || !a) bad(); const obj = { kind: 'fn', ...q, types: a.types }; return { key: keyOf(obj), obj }; }
  if ((m = label.match(/^(table|view|seq|index|type) (\S+)$/))) { const q = qname(m[2]); if (!q) bad(); const obj = { kind: { table: 'tbl', index: 'idx' }[m[1]] || m[1], ...q }; return { key: keyOf(obj), obj }; }
  if ((m = label.match(/^column (\S+)\.([^.]+)$/))) { const t = qname(m[1]); if (!t) bad(); const obj = { kind: 'col', name: unq(m[2]), rel: t }; return { key: keyOf(obj), obj }; }
  if ((m = label.match(/^(policy|trigger|constraint) (.+) on (\S+)$/))) { const t = qname(m[3]); if (!t) bad(); const obj = { kind: { policy: 'pol', trigger: 'trg', constraint: 'con' }[m[1]], name: m[2], rel: t }; return { key: keyOf(obj), obj }; }
  if ((m = label.match(/^(cron|bucket|schema) (\S+)$/))) { const obj = { kind: m[1], name: m[2] }; return { key: keyOf(obj), obj }; }
  if ((m = label.match(/^publication (\S+) has (\S+)$/))) { const t = qname(m[2]); if (!t) bad(); const obj = { kind: 'pub', name: m[1], rel: t }; return { key: keyOf(obj), obj }; }
  // R152: a policy whose expression (USING or WITH CHECK, as pg_get_expr prints it) contains TEXT - for a migration
  // that only ALTERs policies (0343): NAME may contain spaces, the table is the first word after " on "
  if ((m = label.match(/^polexpr (.+?) on (\S+) (.+)$/))) { const t = qname(m[2]); if (!t) bad(); const obj = { kind: 'polexpr', name: m[1], rel: t, text: m[3] }; return { key: keyOf(obj), obj }; }
  // R154: ROLE may run the function (has_function_privilege EXECUTE) - for a migration that only GRANTs (0346)
  if ((m = label.match(/^execute ([a-z_]+) ([^(]+)\(([^)]*)\)$/))) { const q = qname(m[2]); const a = parseArgs(m[3]); if (!q || !a) bad(); const obj = { kind: 'exec', ...q, types: a.types, role: m[1] }; return { key: keyOf(obj), obj }; }
  if ((m = label.match(/^marker ([^(]+)\(([^)]*)\) (.+)$/))) { const q = qname(m[1]); const a = parseArgs(m[2]); if (!q || !a) bad(); const obj = { kind: 'marker', ...q, types: a.types, text: m[3] }; return { key: keyOf(obj), obj }; }
  return bad();
}

// ---------------------------------------------------------------------------------------------------------
// 5) SQL
// ---------------------------------------------------------------------------------------------------------
const lit = (x) => (x === null || x === undefined ? 'null' : "'" + String(x).replace(/'/g, "''") + "'");
// one VALUES row per object: (migration id, kind, schema / relation, name, extra)
function rowSql(id, x) {
  const o = x.obj;
  switch (x.body ? 'body' : o.kind) {
    case 'fn': return [id, 'fn', o.schema, o.name, o.types.join(',')];
    case 'body': return [id, 'body', o.schema, o.name, o.types.join(',') + '|' + x.md5];
    case 'tbl': case 'view': case 'seq': case 'idx': return [id, o.kind, rel(o), null, null];
    case 'type': return [id, 'type', rel(o), null, null];
    case 'col': case 'pol': case 'trg': case 'con': return [id, o.kind, rel(o.rel), o.name, null];
    case 'schema': case 'cron': case 'bucket': case 'pre': return [id, o.kind, null, o.name, null];
    case 'pub': return [id, 'pub', rel(o.rel), o.name, null];
    case 'marker': return [id, 'marker', o.schema, o.name, o.types.join(',') + '|' + o.text];
    case 'polexpr': return [id, 'polexpr', rel(o.rel), o.name, o.text];
    case 'exec': return [id, 'exec', o.schema, o.name, o.types.join(',') + '|' + o.role];
    default: throw new Error(o.kind);
  }
}

export function render({ migs, rows }) {
  const objRows = [], migRows = [];
  rows.forEach(({ mg, o, list }, i) => {
    migRows.push(`  (${i + 1}, ${lit(mg.id)}, ${lit(o.status || null)}, ${lit(o.note || null)})`);
    for (const x of list) objRows.push('  (' + rowSql(mg.id, x).map(lit).join(', ') + ')');
  });
  const kinds = {};
  rows.forEach(({ list }) => list.forEach((x) => { const k = x.body ? 'body' : x.obj.kind; kinds[k] = (kinds[k] || 0) + 1; }));
  const kindLine = Object.entries(kinds).sort().map(([k, v]) => `${k} ${v}`).join(', ');
  return `-- CHECK-PROD-MIGRATIONS.sql - READ ONLY. Changes nothing. One SELECT, one result grid.
-- GENERATED by scripts/gen-check-prod.mjs from supabase/migrations/MANIFEST (+ supabase/check-prod-overrides.json).
-- Do not edit by hand: run  node scripts/gen-check-prod.mjs  (npm run ci fails when this file is out of date).
--
-- HOW TO USE (docs/RUNBOOK-MIGRATIONS.md): after every release paste this whole file into the Supabase SQL
-- editor - STAGING first, then PRODUCTION - and press Run. One row per MANIFEST entry (${migs.length} rows),
-- problems first:
--   missing  = none of the things this migration makes are on this database   -> paste its APPLY-NNNN.sql
--   partial  = some are, some are not (see missing_objects)                   -> paste its APPLY-NNNN.sql
--              (APPLY files are safe to run twice; "body ..." = the function exists but is an older version)
--   optional = intentionally not applied everywhere (see note)
--   skip     = makes nothing that can be checked (see note)
--   superseded = everything it made was later re-issued or removed (checked under the later migration)
--   not visible = its only objects are a cron job / realtime publication entry this login cannot see
--   present  = everything this migration makes was found
-- found = objects found / objects checked. missing_objects = the first ${MAX_SHOWN} names that were not found.
-- Cron jobs / realtime publication rows are only checked where cron.job / the publication exist and are readable
-- (else they are not counted and the note says so).
--
-- What is checked (${objRows.length} objects): ${kindLine}.
--   fn = function by name + argument types (pg_proc); body = md5 of the function body this migration wrote
--   (the newest version); pre = old bodies kept as *__preNNNN; table / view / seq / column / index / policy /
--   trigger / constraint / type / schema / cron job / storage bucket / realtime publication table by name;
--   marker = the function body contains a text the migration puts there (from check-prod-overrides.json).
--   polexpr = the policy USING / WITH CHECK expression contains a text the migration puts there (overrides).
--   exec = the named role may run the function (EXECUTE granted by the migration, from overrides).
with o(m, k, s, n, x) as (values
${objRows.join(',\n')}
),
mig(ord, m, ov, note) as (values
${migRows.join(',\n')}
),
env as (
  select
    case when to_regclass('cron.job') is null then null::text[]
         when not has_table_privilege(to_regclass('cron.job'), 'select') then null::text[]
         else coalesce(xpath('/table/row/jobname/text()', query_to_xml('select jobname from cron.job', false, false, ''))::text[], '{}')
    end as jobs,
    case when to_regclass('storage.buckets') is null then null::text[]
         when not has_table_privilege(to_regclass('storage.buckets'), 'select') then null::text[]
         else coalesce(xpath('/table/row/id/text()', query_to_xml('select id from storage.buckets', false, false, ''))::text[], '{}')
    end as buckets
),
r as (
  select o.m,
    case o.k
      when 'fn' then 'fn ' || o.s || '.' || o.n || '(' || o.x || ')'
      when 'body' then 'body ' || o.s || '.' || o.n || '(' || split_part(o.x, '|', 1) || ')'
      when 'marker' then 'marker ' || o.s || '.' || o.n || '(' || split_part(o.x, '|', 1) || ') ' || substr(o.x, position('|' in o.x) + 1)
      when 'pub' then 'publication ' || o.n || ' has ' || o.s
      when 'col' then 'column ' || o.s || '.' || o.n
      when 'pol' then 'policy ' || o.n || ' on ' || o.s
      when 'polexpr' then 'polexpr ' || o.n || ' on ' || o.s || ' ' || o.x
      when 'exec' then 'execute ' || substr(o.x, position('|' in o.x) + 1) || ' ' || o.s || '.' || o.n || '(' || split_part(o.x, '|', 1) || ')'
      when 'trg' then 'trigger ' || o.n || ' on ' || o.s
      when 'con' then 'constraint ' || o.n || ' on ' || o.s
      when 'tbl' then 'table ' || o.s
      when 'idx' then 'index ' || o.s
      when 'pre' then 'pre *' || o.n
      when 'schema' then 'schema ' || o.n
      when 'cron' then 'cron ' || o.n
      when 'bucket' then 'bucket ' || o.n
      else o.k || ' ' || o.s
    end as label,
    case o.k
      when 'fn' then exists (select 1 from pg_proc p
        where p.pronamespace = to_regnamespace(o.s) and p.proname = o.n
          and p.proargtypes::text = coalesce((select string_agg(coalesce(to_regtype(t)::oid, 0)::text, ' ' order by i)
                                              from unnest(string_to_array(o.x, ',')) with ordinality u(t, i)), ''))
      when 'body' then exists (select 1 from pg_proc p
        where p.pronamespace = to_regnamespace(o.s) and p.proname = o.n and md5(p.prosrc) = split_part(o.x, '|', 2)
          and p.proargtypes::text = coalesce((select string_agg(coalesce(to_regtype(t)::oid, 0)::text, ' ' order by i)
                                              from unnest(string_to_array(split_part(o.x, '|', 1), ',')) with ordinality u(t, i)), ''))
      when 'marker' then exists (select 1 from pg_proc p
        where p.pronamespace = to_regnamespace(o.s) and p.proname = o.n and position(substr(o.x, position('|' in o.x) + 1) in p.prosrc) > 0
          and p.proargtypes::text = coalesce((select string_agg(coalesce(to_regtype(t)::oid, 0)::text, ' ' order by i)
                                              from unnest(string_to_array(split_part(o.x, '|', 1), ',')) with ordinality u(t, i)), ''))
      when 'pub' then case when not exists (select 1 from pg_publication b where b.pubname = o.n) then null
                           else exists (select 1 from pg_publication_tables b where b.pubname = o.n and b.schemaname || '.' || b.tablename = o.s) end
      when 'tbl' then to_regclass(o.s) is not null
      when 'view' then to_regclass(o.s) is not null
      when 'seq' then to_regclass(o.s) is not null
      when 'idx' then to_regclass(o.s) is not null
      when 'type' then to_regtype(o.s) is not null
      when 'col' then exists (select 1 from pg_attribute a where a.attrelid = to_regclass(o.s) and a.attname = o.n and a.attnum > 0 and not a.attisdropped)
      when 'pol' then exists (select 1 from pg_policy p where p.polrelid = to_regclass(o.s) and p.polname = o.n)
      when 'polexpr' then exists (select 1 from pg_policy p where p.polrelid = to_regclass(o.s) and p.polname = o.n
        and position(o.x in coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')) > 0)
      when 'trg' then exists (select 1 from pg_trigger t where t.tgrelid = to_regclass(o.s) and t.tgname = o.n)
      when 'exec' then exists (select 1 from pg_proc p join pg_roles g on g.rolname = substr(o.x, position('|' in o.x) + 1)
        where p.pronamespace = to_regnamespace(o.s) and p.proname = o.n and has_function_privilege(g.oid, p.oid, 'execute')
          and p.proargtypes::text = coalesce((select string_agg(coalesce(to_regtype(t)::oid, 0)::text, ' ' order by i)
                                              from unnest(string_to_array(split_part(o.x, '|', 1), ',')) with ordinality u(t, i)), ''))
      when 'con' then exists (select 1 from pg_constraint c where c.conrelid = to_regclass(o.s) and c.conname = o.n)
      when 'schema' then to_regnamespace(o.n) is not null
      when 'pre' then exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and right(p.proname, length(o.n)) = o.n)
      when 'cron' then (select o.n = any (env.jobs) from env)
      when 'bucket' then (select o.n = any (env.buckets) from env)
    end as ok
  from o
),
agg as (
  select m, count(ok) as total, count(*) filter (where ok) as found,
         array_agg(label order by label) filter (where not ok) as miss,
         string_agg(label, ', ' order by label) filter (where ok is null) as unknown
  from r group by m
)
select mig.m as migration,
       case when mig.ov is not null then mig.ov
            when coalesce(a.total, 0) = 0 and a.unknown is not null then 'not visible'
            when coalesce(a.total, 0) = 0 then 'skip'
            when a.found = a.total then 'present'
            when a.found = 0 then 'missing'
            else 'partial' end as status,
       coalesce(a.found || '/' || a.total, '-') as found,
       coalesce(array_to_string(a.miss[1:${MAX_SHOWN}], ', ')
                || case when cardinality(a.miss) > ${MAX_SHOWN} then ' (+' || (cardinality(a.miss) - ${MAX_SHOWN}) || ' more)' else '' end, '') as missing_objects,
       concat_ws('; ', mig.note, 'not checked here (cron.job / publication / storage not visible): ' || a.unknown) as note
from mig left join agg a on a.m = mig.m
order by case when mig.ov is not null then 2
              when coalesce(a.total, 0) = 0 then 3
              when a.found = 0 then 0
              when a.found < a.total then 1
              else 4 end,
         mig.ord;
`;
}

// ---------------------------------------------------------------------------------------------------------
// 6) main (only when run as a script; test/r150-check-prod.test.mjs imports the functions above)
// ---------------------------------------------------------------------------------------------------------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const built = build({ loose: argv.includes('--loose') });   // --loose: report problems instead of failing (debug)
  for (const w of [...built.problems, ...built.warnings]) console.warn('  ! ' + w);
  if (argv.includes('--list')) {                               // --list NNNN: the objects checked for one migration
    const want = argv[argv.indexOf('--list') + 1];
    for (const { mg, o, list } of built.rows) if (mg.id === want || mg.num === want) {
      console.log(mg.id + (o.status ? ` [${o.status}]` : '') + (o.note ? ` - ${o.note}` : ''));
      for (const x of list) console.log('  ' + x.key);
    }
    process.exit(0);
  }
  const sql = render(built);
  if (/[^\x09\x0a\x0d\x20-\x7e]/.test(sql)) throw new Error('generated SQL is not ASCII');
  if (argv.includes('--check')) {
    const have = existsSync(ROOT + OUT) ? rd(OUT) : '';
    if (have !== sql) {
      console.error(`  \u2717 ${OUT} is out of date vs ${MAN} (a migration or ${OVR} changed). Run: node scripts/gen-check-prod.mjs`);
      process.exit(1);
    }
    console.log(`  \u2713 ${OUT} current (${built.rows.length} MANIFEST entries)`);
  } else {
    writeFileSync(ROOT + OUT, sql);
    const objs = built.rows.reduce((n, r) => n + r.list.length, 0);
    console.log(`wrote ${OUT}: ${built.rows.length} MANIFEST entries, ${objs} objects, ${(sql.length / 1024).toFixed(0)} KB`);
  }
}
