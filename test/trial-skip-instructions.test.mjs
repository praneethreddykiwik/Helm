import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const N = require("../public/trial-test-note.js");
const TEXT = "In a real studio your client verifies with a one-time code sent to their phone, then pays by UPI/card through the payment link. In this trial you can skip that step.";

test("noteSpec: only active trial studios on flow/settlement", () => {
  assert.equal(N.noteSpec(null, "flow"), null);
  assert.equal(N.noteSpec({ is_trial_org: false }, "flow"), null);
  assert.equal(N.noteSpec({ is_trial_org: true, ended: true }, "flow"), null);
  assert.equal(N.noteSpec({ is_trial_org: true, locked: true }, "settlement"), null);
  assert.equal(N.noteSpec({ is_trial_org: true }, "dashboard"), null);
  const f = N.noteSpec({ is_trial_org: true }, "flow");
  assert.equal(f.text, TEXT); assert.equal(f.method, "cash"); assert.equal(f.anchor, "#pay_terms");
  assert.equal(N.noteSpec({ is_trial_org: true }, "settlement").anchor, "#pay_block");
});
// R113 (ae0d6625, 0322): a free-trial client approval is TEST MODE - nothing is ever sent, the client uses the test
// code 000000 - so approve.html now carries the test-mode instructions instead of the older "you can skip that step"
// text (that text stays the flow / settlement note, checked above via noteSpec).
test("pages wire it up; approve.html carries the test-mode instructions + existing Skip OTP", () => {
  const ap = readFileSync(new URL("../public/approve.html", import.meta.url), "utf8");
  assert.ok(!ap.includes(TEXT), "approve.html no longer shows the pre-R113 skip text");
  assert.match(ap, /<p class="muted" id="trialSkipInfo"><b>Test mode<\/b> &mdash; [^<]*No code is sent to you; use the test code 000000\.<\/p>/);
  assert.ok(ap.includes('id="trialSkipBtn"')); assert.ok(ap.includes("trialTestMode("));
  for (const p of ["flow", "settlement"]) assert.ok(readFileSync(new URL(`../public/${p}.html`, import.meta.url), "utf8").includes('src="trial-test-note.js?v=4"'));
  const js = readFileSync(new URL("../public/trial-test-note.js", import.meta.url), "utf8");
  assert.ok(!/innerHTML|\.style\.|setAttribute\("style"/.test(js));
});
