#!/usr/bin/env node
// R176 smoke - anonymous HTTP checks (no browser, no login): A1 A2 A3 A6 A7 A8.
//   node tests/smoke/anon.mjs --target=prod|staging|https://host [--compare-repo]
// Read-only GETs, ~1 request a second. Never prints keys or secrets. Exit 1 when any check fails.
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  baseFor, PUBLIC_PAGES, LEGAL_PAGES, REQUIRED_HEADERS, FRAME_GUARD, PACE_MS, USER_AGENT, TIMEOUT_MS,
} from './config.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const target = arg('target') || process.env.SMOKE_TARGET || 'staging';
const BASE = baseFor(target);
const compareRepo = process.argv.includes('--compare-repo') || process.env.SMOKE_COMPARE_REPO === '1';

const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let last = 0;
async function get(url, opts = {}) {
  const wait = last + PACE_MS - Date.now();
  if (wait > 0) await sleep(wait);
  last = Date.now();
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const res = await fetch(url, { redirect: 'follow', signal: ctl.signal, ...opts, headers: { 'user-agent': USER_AGENT, ...(opts.headers || {}) } });
    const body = await res.text().catch(() => '');
    return { status: res.status, headers: res.headers, body, ms: Date.now() - t0, url: res.url };
  } finally { clearTimeout(t); }
}
async function check(id, name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ id, name, ok: true, detail: detail || '', ms: Date.now() - t0 });
  } catch (e) {
    results.push({ id, name, ok: false, detail: String((e && e.message) || e).slice(0, 300), ms: Date.now() - t0 });
  }
}
const must = (cond, msg) => { if (!cond) throw new Error(msg); };

// A1 - pages load
await check('A1', 'Public + legal pages answer 200', async () => {
  const bad = [];
  for (const p of [...PUBLIC_PAGES, ...LEGAL_PAGES]) {
    const r = await get(BASE + p);
    if (r.status !== 200) bad.push(`${p} -> ${r.status}`);
  }
  must(!bad.length, bad.join(', '));
  return `${PUBLIC_PAGES.length + LEGAL_PAGES.length} pages`;
});

// A2 - health endpoint (R168 api/health.js)
await check('A2', '/api/health says ok', async () => {
  const r = await get(BASE + '/api/health');
  must(r.status === 200, `status ${r.status}`);
  let j = null; try { j = JSON.parse(r.body); } catch (_) { /* not json */ }
  must(j && j.ok === true, 'body is not {ok:true}');
  return `${r.ms} ms`;
});

// A3 - security headers on / and /login
await check('A3', 'Security headers present', async () => {
  const miss = [];
  for (const p of ['/', '/login']) {
    const r = await get(BASE + p);
    for (const h of REQUIRED_HEADERS) if (!r.headers.get(h)) miss.push(`${p}: ${h}`);
    if (FRAME_GUARD) {
      const csp = r.headers.get('content-security-policy') || '';
      if (!r.headers.get('x-frame-options') && !/frame-ancestors/i.test(csp)) miss.push(`${p}: frame protection`);
    }
  }
  must(!miss.length, 'missing ' + miss.join(', '));
  return 'CSP, HSTS, nosniff, frame guard';
});

// A6 - scripts load at the current version (catches stale-cache deploys)
await check('A6', 'store-api.js version loads', async () => {
  const r = await get(BASE + '/login');
  const m = /store-api\.js\?v=(\d+)/.exec(r.body);
  must(m, 'login page does not reference store-api.js?v=');
  const live = m[1];
  const js = await get(`${BASE}/store-api.js?v=${live}`);
  must(js.status === 200, `store-api.js?v=${live} -> ${js.status}`);
  must(/javascript/i.test(js.headers.get('content-type') || ''), 'store-api.js is not served as JavaScript');
  if (compareRepo) {
    const f = join(ROOT, 'public', 'login.html');
    const want = existsSync(f) ? (/store-api\.js\?v=(\d+)/.exec(readFileSync(f, 'utf8')) || [])[1] : null;
    must(want, 'could not read the repo version');
    must(live === want, `live v=${live} but this commit has v=${want} (stale deploy or cache)`);
    return `v=${live} matches this commit`;
  }
  return `v=${live} loads`;
});

// A7 - Supabase reachable (project URL + public anon key read from the site's own public config file)
await check('A7', 'Supabase project reachable', async () => {
  const host = new URL(BASE).hostname;
  const isProd = /(^|\.)helm\.events$/i.test(host);
  const cfg = await get(BASE + (isProd ? '/config.js' : '/config.staging.js'));
  must(cfg.status === 200, `config file -> ${cfg.status}`);
  const url = (/url:\s*"(https:\/\/[a-z0-9]{20}\.supabase\.co)"/.exec(cfg.body) || [])[1];
  const key = (/anonKey:\s*"([^"]+)"/.exec(cfg.body) || [])[1];
  must(url, 'no Supabase project URL in the public config');
  const h = await get(url + '/auth/v1/health', key ? { headers: { apikey: key } } : {});
  must(h.status === 200, `auth health -> ${h.status}`);
  const ref = url.slice(8, 14);
  return `project ${ref}… auth ok (${h.ms} ms)`;
});

// A8 - containment: the site is static; /api/* other than health is not served (reuses check-deploy-static.mjs)
await check('A8', 'Static deploy containment', async () => {
  const p = spawnSync(process.execPath, [join(ROOT, 'scripts', 'check-deploy-static.mjs'), `--url=${BASE}`], { encoding: 'utf8', timeout: 60000 });
  const out = `${p.stdout || ''}${p.stderr || ''}`;
  must(p.status === 0, (out.split('\n').filter((l) => l.includes('✗')).join('; ') || `exit ${p.status}`).slice(0, 280));
  return 'api/* contained, entry pages load';
});

// ---- report ----
const pass = results.filter((r) => r.ok).length;
const lines = results.map((r) => `${r.ok ? 'PASS' : 'FAIL'}  ${r.id}  ${r.name}${r.detail ? '  -  ' + r.detail : ''}`);
console.log(`Helm smoke (anonymous) against ${BASE}\n` + lines.join('\n') + `\n${pass}/${results.length} passed`);
const outDir = join(ROOT, 'tests', 'smoke', 'out');
try { mkdirSync(outDir, { recursive: true }); writeFileSync(join(outDir, `anon-${new URL(BASE).hostname}.json`), JSON.stringify({ base: BASE, at: new Date().toISOString(), results }, null, 2)); } catch (_) { /* best effort */ }
if (process.env.GITHUB_STEP_SUMMARY) {
  const md = [`### Smoke - anonymous checks - ${BASE}`, '', '| | Check | Result | Time |', '|---|---|---|---|',
    ...results.map((r) => `| ${r.ok ? '✅' : '❌'} | ${r.id} ${r.name} | ${String(r.detail).replace(/\|/g, '/')} | ${r.ms} ms |`), '',
    `**${pass}/${results.length} passed**`, ''];
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, md.join('\n') + '\n');
}
process.exit(pass === results.length ? 0 : 1);
