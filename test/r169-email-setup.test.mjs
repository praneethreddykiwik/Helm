// R169: "email that actually sends" - safe, no-send improvements.
//   1. emailSetupHints(env): a pure, value-free dry-run advisory (logic.mjs). Never sends, never
//      echoes a secret value; flags the common mis-configs - the Supabase-Edge 587 block, the Gmail
//      465 testing path, a free-mailbox From that can't be DKIM-aligned, and missing RESEND_FROM.
//   2. status response carries email.hints (additive; the frontend still only reads email.live/sender).
//   3. smtpReason "connect" now names the Supabase 25/587 block + the 465 fix.
// Pure + static checks only. No network, no Deno, nothing is sent.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const L = await import("../supabase/functions/integrations-test/logic.mjs");
const env = (o) => (k) => o[k];
let n = 0;
const t = (name, fn) => { try { fn(); n++; } catch (e) { console.error("FAIL " + name); throw e; } };

const codes = (hints) => hints.map((h) => h.code);
const noSecrets = (hints, values) => {
  const blob = JSON.stringify(hints);
  for (const v of values) if (v) assert.ok(!blob.includes(v), "hint must not echo the secret value: " + v);
};

t("no provider -> one error hint, names the settings only", () => {
  const h = L.emailSetupHints(env({}));
  assert.deepEqual(codes(h), ["not_configured"]);
  assert.equal(h[0].level, "error");
});

t("RESEND_API_KEY set but RESEND_FROM missing -> actionable error, key value never echoed", () => {
  const secret = "re_live_SECRETKEY123";
  const h = L.emailSetupHints(env({ RESEND_API_KEY: secret }));
  assert.deepEqual(codes(h), ["resend_from_missing"]);
  assert.equal(h[0].level, "error");
  noSecrets(h, [secret]);
});

t("SMTP set but SMTP_FROM not an address -> error", () => {
  const h = L.emailSetupHints(env({ SMTP_HOST: "smtp.gmail.com", SMTP_USER: "not-an-address", SMTP_PASS: "pw" }));
  assert.deepEqual(codes(h), ["smtp_from_missing"]);
});

t("Gmail on 587 (Supabase blocks it) -> error smtp_port_blocked + gmail hints; password never echoed", () => {
  const pass = "abcdefghijklmnop";
  const h = L.emailSetupHints(env({ SMTP_HOST: "smtp.gmail.com", SMTP_USER: "me@gmail.com", SMTP_PASS: pass, SMTP_PORT: "587" }));
  const c = codes(h);
  assert.ok(c.includes("smtp_port_blocked"), "flags the blocked port");
  assert.equal(h.find((x) => x.code === "smtp_port_blocked").level, "error");
  assert.ok(c.includes("gmail_use_465"));
  assert.ok(c.includes("gmail_testing_only"));
  assert.ok(c.includes("free_from_not_aligned"), "gmail From can't align");
  noSecrets(h, [pass]);
});

t("Gmail on 465 (the working testing path) -> info-only, no error", () => {
  const h = L.emailSetupHints(env({ SMTP_HOST: "smtp.gmail.com", SMTP_USER: "me@gmail.com", SMTP_PASS: "pw", SMTP_PORT: "465" }));
  const c = codes(h);
  assert.ok(!c.includes("smtp_port_blocked"), "465 is not blocked");
  assert.ok(!c.includes("gmail_use_465"), "465 is already correct");
  assert.ok(c.includes("gmail_testing_only"));
  assert.ok(!h.some((x) => x.level === "error"), "465 Gmail send is not an error");
});

t("Gmail with default port (unset -> mailer defaults to 465) -> no port error", () => {
  const h = L.emailSetupHints(env({ SMTP_HOST: "smtp.gmail.com", SMTP_USER: "me@gmail.com", SMTP_PASS: "pw" }));
  assert.ok(!codes(h).includes("smtp_port_blocked"));
  assert.ok(!codes(h).includes("gmail_use_465"), "unset port means the 465 default");
});

t("Resend with a verified custom-domain From -> no hints (clean production setup)", () => {
  const h = L.emailSetupHints(env({ RESEND_API_KEY: "re_x", RESEND_FROM: "Helm <mail@helm.events>" }));
  assert.deepEqual(h, []);
});

t("Resend with a free-mailbox From -> alignment warning", () => {
  const h = L.emailSetupHints(env({ RESEND_API_KEY: "re_x", RESEND_FROM: "me@gmail.com" }));
  assert.deepEqual(codes(h), ["free_from_not_aligned"]);
  assert.equal(h[0].level, "warn");
});

t("status response wires email.hints additively (frontend still reads live/sender)", () => {
  const idx = read("supabase/functions/integrations-test/index.ts");
  assert.match(idx, /emailSetupHints/);
  assert.match(idx, /hints: emailSetupHints\(env\)/);
  // the existing shape is preserved
  assert.match(idx, /\.\.\.st\.email/);
});

t("smtpReason connect now names the Supabase 25/587 block and the 465 fix", () => {
  const smtp = read("supabase/functions/_shared/smtp.ts");
  assert.match(smtp, /ports 25 and 587 are blocked/);
  assert.match(smtp, /SMTP_PORT 465/);
});

t("mailer still supports Gmail App Password over SMTP as-is (465 implicit TLS, SMTP_FROM default SMTP_USER)", () => {
  const mailer = read("supabase/functions/_shared/mailer.ts");
  assert.match(mailer, /SMTP_PORT.*465|465/);
  assert.match(mailer, /tls: port === 465/);
  assert.match(mailer, /sfrom = env\("SMTP_FROM"\) \|\| user/);
  // Gmail is called out as a supported SMTP setup in the header
  assert.match(mailer, /Gmail/);
});

console.log("r169-email-setup: " + n + " checks passed");
