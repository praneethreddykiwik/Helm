// R138: Sentry's browser bundle is served from our own origin (no outside script host), the file is
// the Sentry-published bundle (R140: now 10.78.0) minus its sourceMappingURL line, its SRI matches the bytes, and
// the retired "browsing-topics" Permissions-Policy token (Chrome warns "Unrecognized feature") is gone.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
const require = createRequire(import.meta.url);
const r = (p) => readFileSync(p, "utf8");
const tel = r("public/telemetry.js");
const src = tel.match(/var SENTRY_SRC = '([^']+)'/)[1];
const sri = tel.match(/var SENTRY_SRI = '([^']+)'/)[1];
assert.equal(src, "/vendor/sentry-10.78.0.bundle.min.js");
const bytes = readFileSync("public" + src);
assert.equal("sha384-" + createHash("sha384").update(bytes).digest("base64"), sri, "SRI matches the vendored file");
assert.ok(!/sourceMappingURL/.test(bytes.toString("utf8").slice(-300)), "no source-map pointer (we ship no map)");
assert.ok(bytes.length > 60000, "the real bundle, not a stub");
const H = require("../scripts/csp-hashes.cjs");
assert.deepEqual(H.SCRIPT_SRC_BASE, ["'self'"]);
for (const f of ["vercel.json", "public/_headers", "server.js", "public/trusted-types.js", "scripts/csp-hashes.cjs"]) {
  const s = r(f);
  assert.ok(!/https:\/\/browser\.sentry-cdn\.com/.test(s.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "")), f + " has no Sentry CDN host");
  assert.ok(!/browsing-topics/.test(s), f + " has no browsing-topics token");
}
assert.match(r("public/_headers"), /connect-src [^\n]*ingest\.us\.sentry\.io/, "error reports can still reach the DSN host");
assert.match(r("public/vendor/README.md"), /Sentry 10\.78\.0 \(self-hosted since R138, upgraded in R140\)/);
// R140: 8.55.2 -> 10.78.0. One Sentry file only (nothing stale), its banner names the same version as its
// file name, still the plain errors-only bundle, and the v9+ init semantics are respected.
import { readdirSync } from "node:fs";
const vend = readdirSync("public/vendor").filter((f) => /sentry/i.test(f));
assert.deepEqual(vend, ["sentry-10.78.0.bundle.min.js"], "exactly one vendored Sentry bundle");
const head = bytes.toString("utf8", 0, 200);
assert.match(head, /^\/\*! @sentry\/browser 10\.78\.0 /, "banner version matches the file name");
assert.ok(!/bundle\.(tracing|replay|feedback|logs)/.test(src), "plain bundle variant");
assert.ok(bytes.toString("utf8").endsWith("}({});\n"), "only the sourceMappingURL line was removed");
assert.match(tel, /tracesSampleRate: traceRate\(CFG\.tracesSampleRate\) \|\| undefined,/, "v9+: a defined 0 means tracing on - leave it out");
assert.match(tel, /sendDefaultPii: false,/, "v10: no IP inference, no default PII");
assert.doesNotMatch(tel.replace(/\/\/[^\n]*/g, ""), /autoSessionTracking|enableTracing|getCurrentHub|captureUserFeedback|_experiments/, "no options/APIs removed in v9/v10");
// R140 live check found: console breadcrumbs keep the logged values in data.arguments (an ARRAY) and
// "otp=123456" kept its code - both are scrubbed now.
import vm from "node:vm";
const w = { addEventListener() {}, HELM_TELEMETRY: {} }; w.window = w;
vm.runInNewContext(tel, Object.assign(w, { document: { createElement: () => ({}), head: { appendChild() {} } },
  location: { pathname: "/", hostname: "x", search: "" }, console }));
const T = w.HelmTelemetry;
const crumb = JSON.stringify(T.redactBreadcrumb({ category: "console", data: { logger: "console",
  arguments: ["saved for priya@example.com 9876543210 Rs 1,25,000", { email: "x@y.co", phone: 9876543210, url: "https://h/p?token=zz" }] } }));
assert.doesNotMatch(crumb, /priya@example|x@y\.co|9876543210|1,25,000|token=zz/, crumb);
assert.match(crumb, /"url":"https:\/\/h\/p"/, "URL keys inside arrays lose their query too");
const ex = JSON.stringify(T.redactEvent({ extra: { arguments: ["a@b.in", ["9876543210"]] } }).extra);
assert.doesNotMatch(ex, /a@b\.in|9876543210/, ex);
assert.doesNotMatch(T.redact("failed otp=482913 / OTP: 123456"), /482913|123456/);
console.log("r138-sentry-self-host: ok");
