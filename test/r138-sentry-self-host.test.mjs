// R138: Sentry's browser bundle is served from our own origin (no outside script host), the file is
// the Sentry-published 8.55.2 bundle minus its sourceMappingURL line, its SRI matches the bytes, and
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
assert.equal(src, "/vendor/sentry-8.55.2.bundle.min.js");
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
assert.match(r("public/vendor/README.md"), /Sentry 8\.55\.2 \(self-hosted since R138\)/);
console.log("r138-sentry-self-host: ok");
