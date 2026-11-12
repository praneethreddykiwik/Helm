// R142: edge hardening - provider timeouts, Sentry on every function, request-id logs - plus the browser fetch timeout.
//   1. no edge-function source calls fetch() directly: every outbound call goes through _shared/http.ts
//      (fetchWithTimeout, AbortSignal.timeout, 10 s default); the SMTP connect / STARTTLS have a deadline too
//   2. every function entry reports unexpected failures to Sentry: responders().serverError, or sentryOnce (one event
//      per request) in its top-level catch; the cron senders also report a run with failed rows (once)
//   3. JSON log helper (_shared/log.ts) with the request id; function entries no longer print free-form console lines
//   4. public/store-api.js: Supabase calls through the shared wrapper give up after 30 s and fail as a NETWORK error
//      (the normal "Couldn't reach the server" message), except with a caller signal / Storage / Edge Functions
// Static + vm checks only (no network). The Deno behaviour tests are tests/edge/r142-timeouts.test.ts.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";

const r = (p) => readFileSync(p, "utf8");
const FN = "supabase/functions";
let n = 0;
const t = async (name, fn) => { try { await fn(); n++; } catch (e) { console.error("FAIL " + name); throw e; } };
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'\\])\/\/[^\n]*/g, "$1");
function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|mjs|js)$/.test(f) && !/_test\.ts$/.test(f)) out.push(p);
  }
  return out;
}
const SRC = walk(FN);
const FUNCS = readdirSync(FN).filter((d) => d !== "_shared" && statSync(join(FN, d)).isDirectory() && SRC.includes(join(FN, d, "index.ts")));
const PROVIDERS = /graph\.facebook\.com|api\.razorpay\.com|api\.resend\.com|control\.msg91\.com|challenges\.cloudflare\.com|api\.openai\.com/;

await t("1a no edge source calls fetch() directly (only _shared/http.ts does)", () => {
  const bad = [];
  for (const f of SRC) {
    if (f === join(FN, "_shared/http.ts")) continue;
    const s = strip(r(f));
    if (/(^|[^\w.$])fetch\s*\(/.test(s) || /globalThis\.fetch\s*\(/.test(s)) bad.push(f);
  }
  assert.deepEqual(bad, [], "raw fetch( outside the helper");
  assert.ok(SRC.length > 40 && FUNCS.length === 25, "scanned " + SRC.length + " files / " + FUNCS.length + " functions");
});
await t("1b every file that talks to a provider or Storage uses fetchWithTimeout from _shared/http.ts", () => {
  let users = 0;
  for (const f of SRC) {
    const s = strip(r(f));
    if (f.endsWith("_shared/http.ts") || !/fetchWithTimeout\(/.test(s)) continue;
    assert.match(s, /import \{[^}]*fetchWithTimeout[^}]*\} from "(\.\.\/_shared|\.)\/http\.ts"/, f);
    users++;
  }
  // R154: integrations-test now sends through _shared/mailer.ts (on the helper); R154g: so do comms-dispatch,
  // billing-reminder, pkg-client-notify, security-alert-mailer and razorpay-webhook (their own Resend calls are gone)
  assert.ok(users >= 10, "files on the helper: " + users);
  // a provider host only appears where the call goes through a helper (or in a pure logic / template module)
  for (const f of SRC) {
    const s = strip(r(f));
    if (!PROVIDERS.test(s) || /\.mjs$/.test(f) || f.endsWith("_shared/http.ts")) continue;
    assert.match(s, /fetchWithTimeout|safeFetch|waPost|graphVersion/, f + " names a provider host but has no deadline helper");
  }
  // the rzp / graph wrappers themselves are on the helper
  // R154 / R154g: integrations-test, comms-dispatch, billing-reminder, pkg-client-notify, security-alert-mailer and
  // razorpay-webhook send e-mail only through _shared/mailer.ts (on the helper, checked below) - no own Resend call
  for (const f of ["comms-dispatch", "billing-reminder", "pkg-client-notify", "security-alert-mailer", "razorpay-webhook"]) {
    const s = strip(r(join(FN, f, "index.ts")));
    assert.match(s, /import \{[^}]*\bsendMail\b[^}]*\} from "\.\.\/_shared\/mailer\.ts"/, f);
    assert.doesNotMatch(s, /api\.resend\.com|onboarding@resend\.dev/, f);
  }
  assert.match(r(join(FN, "create-payment-link/index.ts")), /fetchWithTimeout\("https:\/\/api\.razorpay\.com\/v1\/" \+ path/);
  assert.match(r(join(FN, "create-subscription-checkout/index.ts")), /fetchWithTimeout\("https:\/\/api\.razorpay\.com\/v1\/" \+ path/);
  assert.match(r(join(FN, "wa-connect/index.ts")), /const r = await fetchWithTimeout\(u\.toString\(\)/);
  assert.match(r(join(FN, "_shared/wa-sender.ts")), /r = await fetchWithTimeout\(url, \{[\s\S]{0,300}raw = await r\.text\(\);[^\n]*\n\s*\} catch \(e\) \{/,
    "Meta answer read inside the deadline + the network-failure catch");
  assert.match(r(join(FN, "_shared/mailer.ts")), /await fetchWithTimeout\("https:\/\/api\.resend\.com\/emails"/);
  assert.match(r(join(FN, "send-otp/index.ts")), /await fetchWithTimeout\("https:\/\/control\.msg91\.com\/api\/v5\/flow\/"/);
  assert.match(r(join(FN, "captcha-verify/index.ts")), /fetchWithTimeout\(SITEVERIFY_URL, \{[\s\S]*?\}, 8000\)/);
  assert.match(r(join(FN, "render-photo/index.ts")), /fetchWithTimeout\(OPENAI_EDITS, \{[^\n]*signal: ac\.signal \}, timeout \+ 5_000\)/);
});
await t("1c the helper: AbortSignal.timeout, 10 s default, caller signal combined, global fetch looked up at call time", () => {
  const h = r(join(FN, "_shared/http.ts"));
  assert.match(h, /export const DEFAULT_TIMEOUT_MS = 10_000;/);
  assert.match(h, /AbortSignal\.timeout\(msOf\(ms\)\)/);
  assert.match(h, /return globalThis\.fetch\(url, \{ \.\.\.init, signal: timeoutSignal\(ms, init\.signal\) \}\);/);
  assert.match(h, /\(AbortSignal as any\)\.any/);
  assert.match(h, /name === "TimeoutError"/);
  assert.match(r(join(FN, "_shared/cors.ts")), /e instanceof DOMException\) return String\(e\.name/, "errTag names a timeout");
});
await t("1d SMTP: connect and STARTTLS handshake have a 10 s deadline; a late connection is closed", () => {
  const s = r(join(FN, "_shared/smtp.ts"));
  assert.match(s, /import \{ withDeadline \} from "\.\/http\.ts";/);
  assert.match(s, /const CT = opts\.connectTimeoutMs \?\? 10000;/);
  assert.match(s, /conn = await withDeadline\(opts\.connect \? opts\.connect\(\)\s*: cfg\.tls \? Deno\.connectTls\(\{ hostname: cfg\.host, port: cfg\.port \}\)\s*: Deno\.connect\(\{ hostname: cfg\.host, port: cfg\.port \}\), CT, closeLate\);/);
  assert.match(s, /await withDeadline\(hs\.call\(conn\), CT\)/);
  assert.match(s, /const T = opts\.timeoutMs \?\? 15000;/, "reply timeout unchanged");
});
await t("1e a timeout takes the provider-failure path (never a saved error state, never a new money row)", () => {
  const spc = r(join(FN, "send-phone-code/index.ts"));
  assert.match(spc, /if \(!isTimeout\(e\)\) throw e;[\s\S]{0,120}return json\(\{ error: "could not send the WhatsApp message — try again later" \}, 502\);/);
  const otp = r(join(FN, "send-otp/index.ts"));
  assert.match(otp, /if \(!isTimeout\(e\)\) throw e;[\s\S]{0,120}return json\(\{ error: "could not send the SMS, please try again" \}, 502\);/);
  const wc = r(join(FN, "wa-connect/index.ts"));
  assert.match(wc, /if \(isTimeout\(e\)\) \{[^\n]*return json\(\{ error: "WhatsApp \(Meta\) did not answer in time - try again"(, code: "timeout")? \}, 502\); \}\s*return serverError\(e\);/);
  const csc = r(join(FN, "create-subscription-checkout/index.ts"));
  assert.equal((csc.match(/if \(!isTimeout\(e\)\) throw e;/g) || []).length, 2);
  // a payment-link CREATE that times out is not marked failed (it may exist at Razorpay): generic 500, 2-minute reservation
  const cpl = r(join(FN, "create-payment-link/index.ts"));
  assert.doesNotMatch(cpl, /isTimeout/);
  assert.match(cpl, /reservation is superseded after 2 minutes/);
  const vu = r(join(FN, "verify-upload/index.ts"));
  assert.match(vu, /if \(!isTimeout\(e\)\) throw e;[\s\S]{0,120}return false;   \/\/ like a refused move/);
  assert.match(vu, /\}, 30_000\);/, "Storage download deadline");
});

// ---- 2. Sentry --------------------------------------------------------------------------------------------------
// csp-report is the one exception: a PUBLIC endpoint (no auth, browsers post CSP reports); a malformed report lands in
// its catch by design, so reporting there would let anyone fill the Sentry quota. It stores nothing and answers 204.
const SENTRY_EXEMPT = new Set(["csp-report"]);
await t("2a every function entry reports unexpected failures to Sentry (top-level catch)", () => {
  const viaServerError = [], viaOnce = [];
  for (const f of FUNCS) {
    if (SENTRY_EXEMPT.has(f)) continue;
    const s = r(join(FN, f, "index.ts"));
    const lastCatch = s.slice(s.lastIndexOf("} catch (e) {"));
    assert.ok(s.lastIndexOf("} catch (e) {") > 0, f + ": top-level catch");
    const top = lastCatch.slice(0, lastCatch.indexOf("\n  }\n") > 0 ? lastCatch.indexOf("\n  }\n") : 400);
    if (/return serverError\(e\);/.test(top)) {
      assert.match(s, /const \{ [^}]*serverError[^}]* \} = responders\(req\);/, f);
      viaServerError.push(f);
    } else {
      assert.match(s, /import \{[^}]*\bsentryOnce\b[^}]*\} from "\.\.\/_shared\/cors\.ts";/, f + ": imports sentryOnce");
      assert.match(s, /const report = sentryOnce\(req\);/, f);
      assert.match(top, /report\.error\(e\);/, f + ": top-level catch reports");
      viaOnce.push(f);
    }
  }
  assert.equal(viaServerError.length + viaOnce.length, 24);
  for (const f of ["comms-dispatch", "razorpay-webhook", "razorpay-subscription-webhook", "billing-reminder", "welcome-mailer", "invite-mailer",
    "verify-upload", "wa-webhook", "booklet-snapshot", "create-subscription-checkout", "email-unsubscribe", "pkg-client-notify", "security-alert-mailer"])
    assert.ok(viaOnce.includes(f), f + " (one of the 13 that never reported) now reports");
});
await t("2b cron senders: a run with failed rows sends ONE event (sentryOnce), never one per row", () => {
  for (const f of ["comms-dispatch", "billing-reminder", "pkg-client-notify", "security-alert-mailer", "invite-mailer", "welcome-mailer"])
    assert.match(r(join(FN, f, "index.ts")), /if \(counts\.failed > 0\) report\.fail\("send_failed"\);/, f);
  assert.match(r(join(FN, "verify-upload/index.ts")), /if \(counts\.retry > 0\) report\.fail\("scan_retry"\);/);
  for (const f of ["razorpay-webhook", "razorpay-subscription-webhook", "wa-webhook"]) {
    const s = r(join(FN, f, "index.ts"));
    // every 500 (the provider retries) is reported
    const fiveHundreds = s.split("\n").filter((l) => /status: 500|"error", 500\)/.test(l) && !/^\s*\/\//.test(l));
    for (const l of fiveHundreds) if (!/report(\.error|\.fail)\(|sentryOnce\(req\)\.error/.test(l) && !/^\s*return /.test(l)) assert.fail(f + ": " + l.trim());
  }
  const c = r(join(FN, "_shared/cors.ts"));
  assert.match(c, /export function sentryOnce\(req: Request\) \{\s*let sent = false;\s*const send = \(tag: string\) => \{ if \(sent\) return; sent = true; sentryTag\(req, tag\); \};/);
  assert.match(c, /fail: \(kind: string\) => send\(\/\^\[a-z_\]\{1,40\}\$\/\.test\(kind\) \? kind : "failure"\)/, "a kind is a fixed word, never data");
  assert.match(c, /export function reportToSentry\(req: Request, e: unknown\) \{\s*sentryTag\(req, errTag\(e\)\);/, "serverError path unchanged");
});

// ---- 3. logs ------------------------------------------------------------------------------------------------------
await t("3 JSON logs with the request id; no free-form console lines left in function entries", () => {
  const L = r(join(FN, "_shared/log.ts"));
  assert.match(L, /req\?\.headers\.get\("sb-request-id"\) \|\| req\?\.headers\.get\("x-request-id"\)/);
  assert.match(L, /const o: Record<string, unknown> = \{ level, fn: /);
  assert.match(L, /const looksPrivate = \(s: string\) => \/\[0-9\]\{7,\}\/\.test\(s\) \|\| \/\[0-9a-f\]\{12,\}\/i\.test\(s\);/);
  for (const f of FUNCS) {
    if (f === "csp-report") continue;   // its redacted report line IS its output (captcha-csp.test.ts counts them)
    const s = strip(r(join(FN, f, "index.ts")));
    assert.doesNotMatch(s, /console\.(log|error|warn)\(/, f);
    assert.match(s, /import \{ logger \} from "\.\.\/_shared\/log\.ts";/, f);
  }
  assert.match(r(join(FN, "_shared/cors.ts")), /logger\(fnName\(req\.url\), req\)\.error\("internal error", errTag\(e\)\);/);
});

// ---- 4. browser -----------------------------------------------------------------------------------------------------
const API = r("public/store-api.js");
await t("4a store-api: the Supabase fetch wrapper has a 30 s timeout (not with a caller signal, not Storage / Functions)", () => {
  assert.match(API, /const FETCH_TIMEOUT_MS = 30000;/);
  assert.match(API, /const NO_FETCH_TIMEOUT = \/\\\/\(storage\|functions\)\\\/v1\\\/\/;/);
  const cf = /function coalescedFetch\(input, init\) \{[\s\S]*?\n  \}\n/.exec(API)[0];
  assert.match(cf, /if \(!\/\\\/rest\\\/v1\\\/\/\.test\(u\)\) return timedFetch\(input, init\);/);
  assert.match(cf, /if \(init\.signal\) return global\.fetch\(input, init\);/, "a caller's own signal is untouched");
  assert.match(cf, /const wp = timedFetch\(input, init\);/);
  assert.match(cf, /const p = timedFetch\(input, init\);/);
  assert.match(API, /global: \{ fetch: authAwareFetch \}/, "the Supabase client still uses the wrapper");
});
await t("4b store-api: a stalled call rejects as a network error -> the normal offline / try-again message", async () => {
  const src = /  function timedFetch\(input, init\) \{[\s\S]*?\n  \}\n/.exec(API)[0];
  const isNet = /  function isNetworkError\(e\) \{[\s\S]*?\n  \}\n/.exec(API)[0];
  const calls = [];
  const fakeFetch = (u, init) => { calls.push([u, init]); return new Promise((_, reject) => {
    if (init && init.signal) init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }); }); };
  const ctx = vm.createContext({ global: { fetch: fakeFetch }, AbortSignal, TypeError, navigator: { onLine: true }, Object,
    errMsg: (e) => String((e && e.message) || ""), FETCH_TIMEOUT_MS: 40, NO_FETCH_TIMEOUT: /\/(storage|functions)\/v1\//, });
  vm.runInContext(src + isNet + "this.timedFetch = timedFetch; this.isNetworkError = isNetworkError;", ctx);
  let err = null;
  const keepAlive = setTimeout(() => {}, 5000);   // AbortSignal.timeout's timer does not keep node running by itself
  try { await ctx.timedFetch("https://x.supabase.co/rest/v1/quotes?select=id", { method: "GET", cache: "no-store" }); } catch (e) { err = e; } finally { clearTimeout(keepAlive); }
  assert.ok(err && err.name === "TypeError" && /failed to fetch/i.test(err.message) && err.timeout === true, String(err));
  assert.equal(ctx.isNetworkError(err), true);
  assert.equal(calls[0][1].cache, "no-store", "the caller's options are kept");
  // a body that stalls after the headers surfaces through supabase-js as "TimeoutError: signal timed out"
  assert.equal(ctx.isNetworkError({ message: "TimeoutError: signal timed out" }), true);
  assert.equal(ctx.isNetworkError({ message: "canceling statement due to statement timeout" }), false, "a database timeout is not 'offline'");
  // no timeout: caller signal, Storage upload, Edge Function, non-string request
  const ac = new AbortController();
  ctx.timedFetch("https://x.supabase.co/rest/v1/quotes", { signal: ac.signal });
  ctx.timedFetch("https://x.supabase.co/storage/v1/object/event-docs/a.pdf", { method: "POST" });
  ctx.timedFetch("https://x.supabase.co/functions/v1/invite-mailer", { method: "POST" });
  assert.equal(calls[1][1].signal, ac.signal);
  assert.equal(calls[2][1].signal, undefined);
  assert.equal(calls[3][1].signal, undefined);
});
await t("4c store-api cache-buster bumped on every page (one consistent version)", () => {
  const pages = readdirSync("public").filter((f) => f.endsWith(".html"));
  const vs = new Set();
  for (const p of pages) for (const m of r("public/" + p).matchAll(/store-api\.js\?v=(\d+)/g)) vs.add(m[1]);
  assert.deepEqual([...vs], ["345"]);
});

console.log(`r142-edge-hardening: ${n} checks passed`);
