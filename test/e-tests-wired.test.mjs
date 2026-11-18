// audit E (18 Nov 2026): every test/*.test.mjs must actually run. Two tests (r166-email-scrub, r169-email-setup) had been
// written but never added to `npm test`, so nothing ran them. This guard fails when a test file is in test/ but neither
// `npm test` nor `npm run ci` names it, and when a script names a test file that does not exist.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const scripts = (pkg.scripts.test || "") + " " + (pkg.scripts.ci || "");
const named = new Set([...scripts.matchAll(/\btest\/([\w.-]+\.test\.mjs)\b/g)].map((m) => m[1]));
const files = readdirSync(join(ROOT, "test")).filter((f) => f.endsWith(".test.mjs"));

const orphans = files.filter((f) => !named.has(f));
assert.deepEqual(orphans, [], "test files that `npm test` / `npm run ci` never run: " + orphans.join(", "));
const missing = [...named].filter((f) => !existsSync(join(ROOT, "test", f)));
assert.deepEqual(missing, [], "package.json names test files that do not exist: " + missing.join(", "));
console.log("e-tests-wired: all " + files.length + " test files run");
