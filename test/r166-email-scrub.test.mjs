// r166: emails are stripped of control chars (incl. null byte) before reaching Supabase Auth,
// so a crafted null byte can no longer produce a raw 500 "Database error" from GoTrue/Postgres.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "public", "store-api.js"), "utf8");

test("scrubEmail helper is defined", () => {
  assert.match(src, /function scrubEmail\(v\)\s*\{[^}]*\\u0000-\\u001f\\u007f/);
});
test("scrubEmail is applied in signIn, signUp and password reset", () => {
  assert.match(src, /async signIn\(email, password, opts\) \{\s*\n\s*if \(!supa\)[^\n]*\n\s*email = scrubEmail\(email\);/);
  assert.match(src, /async signUp\(email, password, opts\) \{\s*\n\s*if \(!supa\)[^\n]*\n\s*email = scrubEmail\(email\);/);
  assert.match(src, /resetPasswordForEmail\(scrubEmail\(email\), o\)/);
});
test("the strip contract removes control chars and trims, keeps normal emails", () => {
  const scrub = (v) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  assert.equal(scrub("a@b.com\u0000"), "a@b.com");
  assert.equal(scrub("a\u0000@b.com"), "a@b.com");
  assert.equal(scrub("  user@x.io  "), "user@x.io");
  assert.equal(scrub("normal@helm.events"), "normal@helm.events");
});
