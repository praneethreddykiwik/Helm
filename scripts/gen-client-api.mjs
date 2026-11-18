#!/usr/bin/env node
/* gen-client-api.mjs - R216: builds public/client-api.js, the small data script of the client link pages
 * (approve, invite + /i/<slug>, portal, proposal-view, booklet), from
 *   scripts/client-api.template.js   the wrapper: fetch-based Supabase client, init, full-mode hand-over
 *                                    (STORE_API_V = the store-api.js ?v= of public/dashboard.html: re-run after a bump)
 *   public/store-api.js              every client call and page helper, COPIED WORD FOR WORD (parsed with acorn and
 *                                    sliced out by name), so the RPC names, arguments and error handling can never drift
 *
 *   node scripts/gen-client-api.mjs            rewrite public/client-api.js
 *   node scripts/gen-client-api.mjs --check    exit 1 when public/client-api.js is out of date (CI)
 *
 * Template markers (each on its own line):
 *   /*@@top <text>@@*\/                     the top-level statement of store-api.js containing <text> (exactly one)
 *   /*@@decl <name>@@*\/                    the declaration of <name> inside store-api.js's main data module
 *   /*@@stmt <text>@@*\/                    the (non-declaration) statement of that module containing <text>
 *   /*@@members <object>: a, b, c@@*\/      only the listed properties of the object literal <object>
 *                                           (<object> = a const of the module, or BPStore.<name>)
 * The output is also checked for names the copied code uses but nothing declares (a missing dependency). */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const acorn = createRequire(join(ROOT, 'tools', 'build', 'package.json'))('acorn');
const STORE = join(ROOT, 'public', 'store-api.js');
const TEMPLATE = join(ROOT, 'scripts', 'client-api.template.js');
const OUT = join(ROOT, 'public', 'client-api.js');
const CHECK = process.argv.includes('--check');

const parse = (code) => acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true });

export function build(storeSrc, templateSrc, staffHtml) {
  // full mode loads store-api.js at the version the staff pages use (public/dashboard.html is the reference page)
  const sv = /store-api\.js\?v=(\d+)/.exec(staffHtml || readFileSync(join(ROOT, 'public', 'dashboard.html'), 'utf8'));
  if (!sv) throw new Error('gen-client-api: no store-api.js?v= on public/dashboard.html');
  templateSrc = templateSrc.replace('"@@STORE_API_V@@"', '"' + sv[1] + '"');
  const prog = parse(storeSrc);
  const text = (n) => storeSrc.slice(n.start, n.end);
  const one = (list, what) => {
    if (list.length !== 1) throw new Error(`gen-client-api: ${what} matched ${list.length} statements of store-api.js (need exactly 1)`);
    return list[0];
  };
  const mainStmt = one(prog.body.filter((s) => text(s).includes('const SELF_SRC = (typeof document')), 'the main data module');
  const mainFn = mainStmt.expression && mainStmt.expression.callee;
  if (!mainFn || !mainFn.body || !Array.isArray(mainFn.body.body)) throw new Error('gen-client-api: main module is not an IIFE');
  const body = mainFn.body.body;
  const declares = (s, name) => (s.type === 'FunctionDeclaration' && s.id && s.id.name === name)
    || (s.type === 'VariableDeclaration' && s.declarations.some((d) => d.id && d.id.type === 'Identifier' && d.id.name === name));
  const declOf = (name) => one(body.filter((s) => declares(s, name)), `decl ${name}`);
  const objectOf = (path) => {
    const parts = path.split('.');
    const d = declOf(parts[0]).declarations.find((x) => x.id.name === parts[0]);
    let o = d && d.init;
    for (const k of parts.slice(1)) {
      const p = o && o.type === 'ObjectExpression' && o.properties.find((x) => x.key && (x.key.name === k || x.key.value === k));
      o = p && p.value;
    }
    if (!o || o.type !== 'ObjectExpression') throw new Error(`gen-client-api: ${path} is not an object literal in store-api.js`);
    return o;
  };
  const indentOf = (line) => (/^(\s*)/.exec(line) || ['', ''])[1];
  const out = templateSrc.split('\n').map((line) => {
    const m = /^(\s*)\/\*@@(top|decl|stmt|members) (.+?)@@\*\/\s*$/.exec(line);
    if (!m) return line;
    const [, ind, kind, arg] = m;
    if (kind === 'top') return ind + text(one(prog.body.filter((s) => text(s).includes(arg)), `top "${arg}"`));
    if (kind === 'decl') return ind + text(declOf(arg));
    if (kind === 'stmt') return ind + text(one(body.filter((s) => s.type !== 'VariableDeclaration' && s.type !== 'FunctionDeclaration' && text(s).includes(arg)), `stmt "${arg}"`));
    const [obj, list] = arg.split(':');
    const o = objectOf(obj.trim());
    return list.split(',').map((n) => n.trim()).filter(Boolean).map((n) => {
      const p = o.properties.filter((x) => x.key && (x.key.name === n || x.key.value === n));
      if (p.length !== 1) throw new Error(`gen-client-api: ${obj.trim()}.${n} found ${p.length} times in store-api.js`);
      return ind + text(p[0]) + ',';
    }).join('\n');
  }).join('\n');
  const head = '/* GENERATED by scripts/gen-client-api.mjs from scripts/client-api.template.js + public/store-api.js - do not edit. */\n';
  const code = head + out;
  const missing = undeclared(code);
  if (missing.length) throw new Error('gen-client-api: the copied code uses names nothing declares: ' + missing.join(', '));
  return code;
}

// browser / language globals the client pages may use
const GLOBALS = new Set(('window document location history navigator localStorage sessionStorage console fetch Response Request Headers URL ' +
  'URLSearchParams AbortSignal AbortController setTimeout clearTimeout setInterval clearInterval queueMicrotask requestAnimationFrame cancelAnimationFrame ' +
  'Promise Object Array String Number Boolean Math JSON Date RegExp Error TypeError RangeError Map Set WeakMap WeakSet Symbol BigInt Intl ' +
  'isFinite isNaN parseInt parseFloat encodeURIComponent decodeURIComponent encodeURI decodeURI escape undefined NaN Infinity globalThis ' +
  'CustomEvent Event MutationObserver IntersectionObserver ResizeObserver HTMLElement HTMLAnchorElement Node Element CSS CSSStyleSheet ' +
  'getComputedStyle matchMedia alert confirm prompt atob btoa Blob File FileReader Image crypto performance structuredClone ' +
  'arguments self top parent screen HelmUrl __helmAdoptCss __helmAdoptNegCss __HELM_CLIENT_FULL__ STORE_API_V trustedTypes').split(/\s+/));
// store-api.js's own tail (BPStore.mergeAttributes, a staff-only helper never called on the client pages) names three
// private names of the main module; it is copied as it is, so those three are known and allowed
const KNOWN_TAIL = new Set(['mode', 'supa', 'crewWithPay']);
export function undeclared(code) {
  const ast = parse(code);
  const top = new Set();
  for (const s of ast.body) {
    if (s.type === 'FunctionDeclaration' && s.id) top.add(s.id.name);
    if (s.type === 'VariableDeclaration') s.declarations.forEach((d) => { if (d.id.type === 'Identifier') top.add(d.id.name); });
  }
  const missing = new Set();
  // each top-level statement on its own: a name is fine when that statement declares it, the file declares it at the
  // top level, or it is a browser global (so a helper declared only inside BPUI can never hide a missing core name)
  for (const stmt of ast.body) {
    const declared = new Set(top), used = new Set();
    const pat = (p) => {
      if (!p) return;
      if (p.type === 'Identifier') declared.add(p.name);
      else if (p.type === 'ObjectPattern') p.properties.forEach((x) => pat(x.type === 'RestElement' ? x.argument : x.value));
      else if (p.type === 'ArrayPattern') p.elements.forEach(pat);
      else if (p.type === 'AssignmentPattern') pat(p.left);
      else if (p.type === 'RestElement') pat(p.argument);
    };
    const walk = (n, parent, key) => {
      if (!n || typeof n.type !== 'string') return;
      if (n.type === 'VariableDeclarator') pat(n.id);
      if ((n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ClassDeclaration' || n.type === 'ClassExpression') && n.id) declared.add(n.id.name);
      if (/Function/.test(n.type)) n.params.forEach(pat);
      if (n.type === 'CatchClause') pat(n.param);
      if (n.type === 'Identifier') {
        const isKey = parent && ((parent.type === 'MemberExpression' && key === 'property' && !parent.computed)
          || ((parent.type === 'Property' || parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition') && key === 'key' && !parent.computed)
          || parent.type === 'LabeledStatement' || parent.type === 'BreakStatement' || parent.type === 'ContinueStatement');
        if (!isKey) used.add(n.name);
      }
      for (const k of Object.keys(n)) {
        if (k === 'type' || k === 'start' || k === 'end') continue;
        const v = n[k];
        if (Array.isArray(v)) v.forEach((c) => walk(c, n, k)); else if (v && typeof v.type === 'string') walk(v, n, k);
      }
    };
    walk(stmt, null, null);
    const tail = code.slice(stmt.start, stmt.end).includes('BPStore.mergeAttributes = async function');
    used.forEach((x) => { if (!declared.has(x) && !GLOBALS.has(x) && !(tail && KNOWN_TAIL.has(x))) missing.add(x); });
  }
  return [...missing].sort();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const code = build(readFileSync(STORE, 'utf8'), readFileSync(TEMPLATE, 'utf8'));
  if (CHECK) {
    let cur = ''; try { cur = readFileSync(OUT, 'utf8'); } catch (e) {}
    if (cur !== code) { console.error('gen-client-api: public/client-api.js is out of date - run: node scripts/gen-client-api.mjs'); process.exit(1); }
    console.log('gen-client-api: public/client-api.js is up to date (' + code.length + ' bytes)');
  } else {
    writeFileSync(OUT, code);
    console.log('gen-client-api: wrote public/client-api.js (' + code.length + ' bytes)');
  }
}
