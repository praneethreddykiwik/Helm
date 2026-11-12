#!/usr/bin/env node
/* =========================================================================
   loadtest.mjs — zero-dependency HTTP load generator.

   Uses only Node built-ins (global fetch, available in Node >=18). This project
   intentionally has ZERO runtime dependencies; do not add any here.

   Hammers a single URL at a fixed concurrency for a fixed duration and reports
   latency percentiles (p50/p95/p99), throughput (req/s) and error rate.

   Environment / flags (flags override env):
     LOADTEST_URL         target URL           default http://127.0.0.1:4173/
     LOADTEST_CONCURRENCY workers in flight     default 20      (--concurrency N)
     LOADTEST_DURATION    seconds to run        default 10      (--duration S)
     LOADTEST_METHOD      HTTP method           default GET     (--method M)
     LOADTEST_TIMEOUT     per-request ms        default 10000   (--timeout MS)

   Usage:
     node scripts/loadtest.mjs
     LOADTEST_URL=http://127.0.0.1:4173/api/health npm run loadtest
     node scripts/loadtest.mjs --concurrency 50 --duration 20

   SAFETY (R147): a host allowlist is enforced before any request is sent.
     allowed           localhost, 127.0.0.1, ::1, *.vercel.app previews, the staging
                       site (SUPABASE_STAGING.hosts in public/config.staging.js)
     needs a flag      any other host: add --i-know-this-is-not-prod
     ALWAYS refused    helm.events, www.helm.events (and *.helm.events), the old prod
                       alias helm-alpha-nine.vercel.app (PROD_HOSTS in public/config.js)
                       and the production Supabase host (SUPABASE_CONFIG.url) - no flag
                       unlocks these.
   Redirects are NOT followed (a 3xx counts as a response), so an allowed host can
   never bounce the load onto production.
   ========================================================================= */

import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readPub = (f) => { try { return readFileSync(join(ROOT, 'public', f), 'utf8'); } catch { return ''; } };
// production front-end hosts: the fixed list + whatever public/config.js PROD_HOSTS names
export const PROD_HOSTS = (() => {
  const set = new Set(['helm.events', 'www.helm.events', 'helm-alpha-nine.vercel.app']);
  const m = /var PROD_HOSTS = \{([^}]*)\}/.exec(readPub('config.js'));
  if (m) for (const h of m[1].matchAll(/'([a-z0-9.-]+)'\s*:/g)) set.add(h[1]);
  return [...set];
})();
// production Supabase host (SUPABASE_CONFIG.url in public/config.js) + the known ref as a fallback
export const PROD_SUPABASE_HOSTS = (() => {
  const set = new Set(['nqltzgiwznphugcfhmbm.supabase.co']);
  const m = /url:\s*"https:\/\/([a-z0-9]{20}\.supabase\.co)"/.exec(readPub('config.js'));
  if (m) set.add(m[1]);
  return [...set];
})();
export const STAGING_HOSTS = (() => {
  const set = new Set(['helm-v01.vercel.app']);
  const m = /hosts:\s*\[([^\]]*)\]/.exec(readPub('config.staging.js'));
  if (m) for (const h of m[1].matchAll(/"([a-z0-9.-]+)"/g)) set.add(h[1]);
  return [...set];
})();
export const OVERRIDE_FLAG = '--i-know-this-is-not-prod';

// '' = OK to load-test, otherwise the reason it is refused
export function targetProblem(target, { override = false } = {}) {
  let u;
  try { u = new URL(String(target)); } catch { return `not a valid URL: ${target}`; }
  if (!/^https?:$/.test(u.protocol)) return `LOADTEST_URL must be http(s). Got: ${target}`;
  const h = u.hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  if (h === 'helm.events' || h.endsWith('.helm.events') || PROD_HOSTS.includes(h)) return `${h} is PRODUCTION - never load-tested (no flag overrides this)`;
  if (PROD_SUPABASE_HOSTS.includes(h)) return `${h} is the PRODUCTION Supabase project - never load-tested (no flag overrides this)`;
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return '';
  if (STAGING_HOSTS.includes(h) || h.endsWith('.vercel.app')) return '';
  if (override) return '';
  return `${h} is not localhost, a *.vercel.app preview or the staging site - pass ${OVERRIDE_FLAG} if you own it and it is not production`;
}

function argFlag(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

const URL_TARGET = argFlag('url') || process.env.LOADTEST_URL || 'http://127.0.0.1:4173/';
const CONCURRENCY = Number(argFlag('concurrency') || process.env.LOADTEST_CONCURRENCY || 20);
const DURATION_S = Number(argFlag('duration') || process.env.LOADTEST_DURATION || 10);
const METHOD = (argFlag('method') || process.env.LOADTEST_METHOD || 'GET').toUpperCase();
const TIMEOUT_MS = Number(argFlag('timeout') || process.env.LOADTEST_TIMEOUT || 10000);

const IS_MAIN = (() => { try { return import.meta.url === pathToFileURL(process.argv[1] || '').href; } catch { return false; } })();
if (IS_MAIN) {
  const why = targetProblem(URL_TARGET, { override: process.argv.includes(OVERRIDE_FLAG) });
  if (why) { console.error(`Refusing to run: ${why}`); process.exit(2); }
}

const latencies = [];       // ms, successful responses
let ok = 0;
let errors = 0;
let done = false;

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

async function oneRequest() {
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(URL_TARGET, { method: METHOD, signal: controller.signal, redirect: 'manual' });
    // Drain the body so the connection can be reused and latency is realistic.
    await res.arrayBuffer();
    const elapsed = performance.now() - started;
    if (res.status >= 200 && res.status < 400) {
      ok++;
      latencies.push(elapsed);
    } else {
      errors++;
    }
  } catch {
    errors++;
  } finally {
    clearTimeout(timer);
  }
}

async function worker() {
  while (!done) {
    await oneRequest();
  }
}

async function main() {
  console.log(`loadtest → ${METHOD} ${URL_TARGET}`);
  console.log(`concurrency=${CONCURRENCY}  duration=${DURATION_S}s  timeout=${TIMEOUT_MS}ms\n`);

  const wallStart = performance.now();
  const stopTimer = setTimeout(() => { done = true; }, DURATION_S * 1000);

  const workers = Array.from({ length: CONCURRENCY }, () => worker());
  await Promise.all(workers);
  clearTimeout(stopTimer);

  const wallSeconds = (performance.now() - wallStart) / 1000;
  const total = ok + errors;
  const sorted = latencies.slice().sort((a, b) => a - b);
  const errRate = total ? (errors / total) * 100 : 0;

  const fmt = (n) => n.toFixed(1);
  console.log('── results ─────────────────────────────────');
  console.log(`requests      : ${total} (ok=${ok}, errors=${errors})`);
  console.log(`duration      : ${fmt(wallSeconds)} s`);
  console.log(`throughput    : ${fmt(total / wallSeconds)} req/s`);
  console.log(`error rate    : ${fmt(errRate)} %`);
  console.log(`latency p50   : ${fmt(percentile(sorted, 50))} ms`);
  console.log(`latency p95   : ${fmt(percentile(sorted, 95))} ms`);
  console.log(`latency p99   : ${fmt(percentile(sorted, 99))} ms`);
  console.log(`latency max   : ${fmt(sorted.length ? sorted[sorted.length - 1] : 0)} ms`);
  console.log('────────────────────────────────────────────');

  // Non-zero exit if every request failed, so CI/scripts can detect a dead target.
  if (total > 0 && ok === 0) process.exit(1);
}

if (IS_MAIN) main().catch((err) => {
  console.error('loadtest failed:', err);
  process.exit(1);
});
