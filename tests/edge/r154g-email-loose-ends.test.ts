// R154g - e-mail loose ends from the R154d audit. Mock-only: no network (fetch is stubbed and throws on any URL a test
// did not allow), no real SMTP (an in-memory fake server behind Deno.connect / connectTls), no database.
//   1. billing-reminder / security-alert-mailer / pkg-client-notify / razorpay-webhook send through the shared mailer:
//      SMTP-only works; no provider -> rows are NOT marked skipped (left unsent / not claimed / released for retry)
//   2. no "onboarding@resend.dev" fallback sender: no RESEND_FROM -> fail closed, reason logged, nothing sent
//   3. comms-dispatch's Resend lane honours EMAIL_BRAND_MODE and keeps the Idempotency-Key
//   4. comms-dispatch's welcome lane honours HELM_WELCOME_EMAILS_ENABLED ("true" or unset -> on, anything else -> off)
//   5. plain-text parts for the billing / security / payment mails (htmlToText)
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { setEnv, installFetch, jsonResponse, loadHandler, resetSupaMock, supaLog, fetchLog, captureConsoleError } from "./harness.ts";
import { htmlToText, mailConfig, sendMail } from "../../supabase/functions/_shared/mailer.ts";
import { emailProvider, fromHeader, senderAddress } from "../../supabase/functions/integrations-test/logic.mjs";

const g = globalThis as any;
const BASE = { SUPABASE_URL: "https://proj.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-secret", APP_URL: "https://www.helm.events" };
const SMTP = { SMTP_HOST: "smtp.gmail.com", SMTP_PORT: "465", SMTP_USER: "owner@gmail.com", SMTP_PASS: "gmail-app-pass" };
const RESEND = { RESEND_API_KEY: "re_test", RESEND_FROM: "Helm <hello@helm.events>" };
const noFetch = () => installFetch((url) => { throw new Error("no fetch expected: " + url); });
const cron = (secret: string) => new Request("https://fn.local/", { method: "POST", headers: { "x-helm-cron-secret": secret } });

// ---- in-memory fake SMTP server behind Deno.connect / connectTls (same shape as comms-dispatch-vendor-request) ----
type Sent = { from: string; rcpt: string; data: string };
function installFakeSmtp(): { sent: Sent[]; restore: () => void } {
  const sent: Sent[] = [];
  const orig = (Deno as any).connect, origTls = (Deno as any).connectTls, origStart = (Deno as any).startTls;
  const enc = new TextEncoder(), dec = new TextDecoder();
  const fake = () => {
    let out = "220 fake ready\r\n", inbuf = "", inData = false, cur: Sent = { from: "", rcpt: "", data: "" };
    const pump = () => {
      for (;;) {
        if (inData) {
          const end = inbuf.indexOf("\r\n.\r\n"); if (end < 0) return;
          cur.data = inbuf.slice(0, end); inbuf = inbuf.slice(end + 5); inData = false;
          sent.push(cur); cur = { from: "", rcpt: "", data: "" }; out += "250 queued\r\n"; continue;
        }
        const i = inbuf.indexOf("\r\n"); if (i < 0) return;
        const line = inbuf.slice(0, i); inbuf = inbuf.slice(i + 2);
        if (line.startsWith("EHLO")) out += "250-fake\r\n250-STARTTLS\r\n250 AUTH PLAIN\r\n";
        else if (line === "STARTTLS") out += "220 go ahead\r\n";
        else if (line.startsWith("AUTH")) out += "235 ok\r\n";
        else if (line.startsWith("MAIL FROM:")) { cur.from = line.slice(10); out += "250 ok\r\n"; }
        else if (line.startsWith("RCPT TO:")) { cur.rcpt = line.slice(8); out += "250 ok\r\n"; }
        else if (line === "DATA") { out += "354 go\r\n"; inData = true; }
        else if (line === "QUIT") out += "221 bye\r\n";
      }
    };
    return {
      read: (buf: Uint8Array) => { const b = enc.encode(out); out = ""; buf.set(b.subarray(0, buf.length)); return Promise.resolve(b.length ? Math.min(b.length, buf.length) : null); },
      write: (d: Uint8Array) => { inbuf += dec.decode(d); pump(); return Promise.resolve(d.length); },
      close: () => {},
    };
  };
  (Deno as any).connect = () => Promise.resolve(fake());
  (Deno as any).connectTls = () => Promise.resolve(fake());
  (Deno as any).startTls = (conn: any) => Promise.resolve(conn);
  return { sent, restore: () => { (Deno as any).connect = orig; (Deno as any).connectTls = origTls; (Deno as any).startTls = origStart; } };
}
function partsOf(raw: string): { headers: string; text: string; html: string } {
  const [headers] = raw.split("\r\n\r\n");
  const b64s = [...raw.matchAll(/Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)(?:\r\n--|$)/g)].map((m) => m[1].replace(/\r\n/g, ""));
  const d = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s || ""), (c) => c.charCodeAt(0)));
  return { headers, text: d(b64s[0]), html: d(b64s[1] || "") };
}

// ======================= shared mailer: no fallback sender, htmlToText, Idempotency-Key =======================
Deno.test("R154g mailer: no RESEND_FROM -> not set up (fail closed, reason logged, no fetch); never onboarding@resend.dev", async () => {
  const f = noFetch();
  try {
    const env = (o: Record<string, string>) => (k: string) => o[k];
    assertEquals(mailConfig(env({ RESEND_API_KEY: "re_x" })).provider, null);
    assertEquals(mailConfig(env({ RESEND_API_KEY: "re_x" })).note, "RESEND_API_KEY is set but RESEND_FROM is missing or not an e-mail address");
    assertEquals(mailConfig(env({ RESEND_API_KEY: "re_x", RESEND_FROM: "Helm" })).provider, null, "a name without an address is not a sender");
    assertEquals(mailConfig(env({ ...SMTP, SMTP_USER: "apikey" })).provider, null, "SMTP needs an address (SMTP_FROM or an e-mail SMTP_USER)");
    assertEquals(mailConfig(env({ ...SMTP, SMTP_USER: "apikey", SMTP_FROM: "Helm <hi@helm.events>" })).provider, "smtp");
    assertEquals(mailConfig(env({ RESEND_API_KEY: "re_x", ...SMTP })).provider, "smtp", "SMTP still covers a Resend key without sender");
    assertEquals(mailConfig(env({})).note, undefined);
    const { result, logs } = await captureConsoleError(async () =>
      await sendMail({ to: "a@example.com", subject: "s", text: "t" }, { env: env({ RESEND_API_KEY: "re_x" }) }));
    assertEquals(result.status, "not_configured");
    assert(logs.some((l) => l.includes("RESEND_FROM is missing")), "reason logged");
    assert(!logs.join(" ").includes("a@example.com") && !logs.join(" ").includes("re_x"), "no address / secret in logs");
    assertEquals(fetchLog().length, 0);
    // integrations-test logic: same rule, no fallback sender
    assertEquals(senderAddress(""), ""); assertEquals(senderAddress("Helm"), ""); assertEquals(senderAddress("Helm <hi@helm.events>"), "hi@helm.events");
    assertEquals(emailProvider(env({ RESEND_API_KEY: "re_x" })), "");
    assertEquals(emailProvider(env({ ...SMTP, SMTP_USER: "apikey" })), "");
    assertEquals(fromHeader("", "", "Studio"), '"Studio" <>');
  } finally { f(); }
});

Deno.test("R154g mailer: htmlToText keeps words + links, drops tags / head / styles, decodes entities", () => {
  assertEquals(htmlToText('<p>Hi Studio &lt;A&gt;,</p><p>Ends on <b>2026-11-01</b>.</p><p><a href="https://www.helm.events/settings.html?a=1&amp;b=2">Open billing</a></p>'),
    "Hi Studio <A>,\nEnds on 2026-11-01.\nOpen billing (https://www.helm.events/settings.html?a=1&b=2)");
  assertEquals(htmlToText('<html><head><title>T</title><style>p{color:red}</style></head><body><h2>Paid &mdash; A-1</h2>line<br>two &amp; &#39;three&#39;</body></html>'),
    "Paid — A-1\nline\ntwo & 'three'");
  assertEquals(htmlToText('<a href="https://x.test/">https://x.test/</a>'), "https://x.test/");
  assertEquals(htmlToText(null), "");
});

Deno.test("R154g mailer: idempotencyKey -> Resend Idempotency-Key header (only a safe key)", async () => {
  const seen: Record<string, string>[] = [];
  const f = installFetch((url, init) => { if (url === "https://api.resend.com/emails") { seen.push(init?.headers as Record<string, string>); return jsonResponse({ id: "e" }); } throw new Error(url); });
  try {
    const env = (k: string) => ({ ...RESEND } as Record<string, string>)[k];
    assertEquals((await sendMail({ to: "a@example.com", subject: "s", text: "t" }, { env, idempotencyKey: "pkg-c0000000-0000-4000-8000-0000000069a1" })).status, "sent");
    assertEquals((await sendMail({ to: "a@example.com", subject: "s", text: "t" }, { env, idempotencyKey: "bad key\r\nX: y" })).status, "sent");
    assertEquals((await sendMail({ to: "a@example.com", subject: "s", text: "t" }, { env })).status, "sent");
    assertEquals(seen[0]["Idempotency-Key"], "pkg-c0000000-0000-4000-8000-0000000069a1");
    assertEquals(seen[1]["Idempotency-Key"], undefined);
    assertEquals(seen[2]["Idempotency-Key"], undefined);
  } finally { f(); }
});

// ======================= billing-reminder =======================
const REM = "../../supabase/functions/billing-reminder/index.ts";
const RID = "c0000000-0000-4000-8000-0000000000c1", ORG = "b0000000-0000-4000-8000-00000000da02";
const REM_ENV = { ...BASE, HELM_BILLING_REMINDERS_ENABLED: "true", HELM_BILLING_CRON_SECRET: "cron-bill" };
function remDb() {
  resetSupaMock();
  g.__supaRpc = (name: string) => name === "billing_reminder_recheck" ? { data: "send", error: null } : name === "studio_billing_email" ? { data: "owner@studio-a.in", error: null } : { data: null, error: null };
  g.__supaResolver = (table: string, calls: any[]) => {
    if (table === "billing_reminders" && calls.some((c: any) => c[0] === "select")) return { data: [{ id: RID, org_id: ORG, kind: "past_due", period_end: "2026-10-01" }], error: null };
    if (table === "organizations") return { data: { name: "Studio <A>" }, error: null };
    return { data: null, error: null };
  };
}
const remUpdates = () => supaLog().filter((l) => l.table === "billing_reminders" && l.calls.some((c: any) => c[0] === "update"));

Deno.test("R154g billing-reminder: SMTP only -> sent through the shared mailer (Helm Billing, text + html parts), marked email", async () => {
  remDb();
  const r = setEnv({ ...REM_ENV, ...SMTP }); const smtp = installFakeSmtp(); const f = noFetch();
  try {
    const { result, logs } = await captureConsoleError(async () => await (await loadHandler(REM))(cron("cron-bill")));
    const out = await result.json();
    assertEquals([out.sent, out.skipped, out.failed], [1, 0, 0]);
    assertEquals(smtp.sent.length, 1);
    assertEquals(smtp.sent[0].rcpt, "<owner@studio-a.in>");
    const p = partsOf(smtp.sent[0].data);
    assert(/From: "Helm Billing" <owner@gmail\.com>/.test(p.headers), p.headers);
    assert(p.text.includes("Hi Studio <A>,") && p.text.includes("Open billing (https://www.helm.events/settings.html)"), p.text);
    assert(p.text.includes("You received this because"), "transactional footer in the text part");
    assert(p.html.includes("Studio &lt;A&gt;"));
    assertEquals(remUpdates()[0].calls.find((c: any) => c[0] === "update")[1][0].channel, "email");
    assert(!logs.join(" ").includes("owner@studio-a.in"));
  } finally { f(); smtp.restore(); r(); }
});

Deno.test("R154g billing-reminder: RESEND_API_KEY without RESEND_FROM -> nothing sent, no row touched, reason logged", async () => {
  remDb();
  const r = setEnv({ ...REM_ENV, RESEND_API_KEY: "re_test" }); const f = noFetch();
  try {
    const { result, logs } = await captureConsoleError(async () => await (await loadHandler(REM))(cron("cron-bill")));
    assertEquals((await result.json()).status, "no_provider");
    assertEquals(fetchLog().length, 0); assertEquals(remUpdates().length, 0);
    assertEquals(supaLog().filter((l) => l.table === "billing_reminders").length, 0, "rows not even loaded");
    assert(!logs.join(" ").includes("re_test"));
  } finally { f(); r(); }
});

Deno.test("R154g billing-reminder: Resend -> one call with html + text, from the configured address", async () => {
  remDb();
  const r = setEnv({ ...REM_ENV, ...RESEND });
  const f = installFetch((url) => { if (url === "https://api.resend.com/emails") return jsonResponse({ id: "e" }); throw new Error(url); });
  try {
    await (await loadHandler(REM))(cron("cron-bill"));
    const b = JSON.parse(String(fetchLog()[0].init?.body));
    assertEquals(b.from, '"Helm Billing" <hello@helm.events>');
    assertEquals(b.to, ["owner@studio-a.in"]);
    assert(typeof b.text === "string" && b.text.startsWith("Hi Studio <A>,") && !/<p>/.test(b.text));
  } finally { f(); r(); }
});

// ======================= security-alert-mailer =======================
const SEC = "../../supabase/functions/security-alert-mailer/index.ts";
const S1 = "c0000000-0000-4000-8000-0000000054a1";
const SEC_ENV = { ...BASE, HELM_SECURITY_ALERTS_ENABLED: "true", HELM_SECURITY_ALERT_SECRET: "cron-sec", HELM_SECURITY_ALERT_HQ_TO: "hq@helm.events, ops@helm.events" };
function secDb() {
  resetSupaMock();
  g.__supaRpc = (name: string) => name === "security_alert_outbox_claim"
    ? { data: [{ id: S1, hq: true, label: "HQ operator added", count: 3, studio: "Studio A", to: [] }], error: null } : { data: "ok", error: null };
}
const secMarks = () => supaLog().filter((l) => l.rpc === "security_alert_outbox_mark").map((l) => l.args.p_status);

Deno.test("R154g security-alert-mailer: SMTP only -> one mail per HQ address (Helm Security, text part, no links), marked sent", async () => {
  secDb();
  const r = setEnv({ ...SEC_ENV, ...SMTP }); const smtp = installFakeSmtp(); const f = noFetch();
  try {
    const out = await (await (await loadHandler(SEC))(cron("cron-sec"))).json();
    assertEquals(out.sent, 1);
    assertEquals(smtp.sent.map((s) => s.rcpt), ["<hq@helm.events>", "<ops@helm.events>"]);
    const p = partsOf(smtp.sent[0].data);
    assert(/From: "Helm Security" <owner@gmail\.com>/.test(p.headers));
    assert(p.text.includes("Security alert for Studio A:") && p.text.includes("HQ operator added (3 times in about 10 minutes)."), p.text);
    assert(!/https?:\/\//.test(p.text) && !/https?:\/\//.test(p.html), "security mail carries no links");
    assertEquals(secMarks(), ["sent"]);
  } finally { f(); smtp.restore(); r(); }
});

Deno.test("R154g security-alert-mailer: one of two addresses refused -> still sent (no duplicate retry); all refused -> retry", async () => {
  secDb();
  const r = setEnv({ ...SEC_ENV, ...RESEND });
  let n = 0;
  let f = installFetch((url) => { if (url === "https://api.resend.com/emails") return ++n === 1 ? jsonResponse({ error: "x" }, 500) : jsonResponse({ id: "e" }); throw new Error(url); });
  try {
    const h = await loadHandler(SEC);
    await captureConsoleError(async () => await h(cron("cron-sec")));
    assertEquals(secMarks(), ["sent"]);
    f(); secDb();
    f = installFetch(() => jsonResponse({ error: "x" }, 500));
    const { result } = await captureConsoleError(async () => await h(cron("cron-sec")));
    assertEquals((await result.json()).failed, 1);
    assertEquals(secMarks(), ["retry"]);
  } finally { f(); r(); }
});

// ======================= pkg-client-notify =======================
const PKG = "../../supabase/functions/pkg-client-notify/index.ts";
const P1 = "c0000000-0000-4000-8000-0000000069a1";
const PKG_ENV = { ...BASE, HELM_PKG_NOTIFY_ENABLED: "true", HELM_PKG_NOTIFY_SECRET: "cron-pkg" };
const TOK = "a0000000-0000-4000-8000-0000000000aa";
function pkgDb() {
  resetSupaMock();
  g.__supaRpc = (name: string) => name === "pkg_outbox_claim" ? { data: [{ id: P1, audience: "client", channel: "email", kind: "pkg_accepted", to: "alice@client.test",
    payload: { approve_url: "/approve?token=" + TOK, studio: "Studio A", client_name: "Alice", title: "Wedding", total: 1000, paid: 0, balance: 1000, currency: "INR" } }], error: null }
    : { data: null, error: null };
  g.__supaResolver = () => ({ data: null, error: null });
}
const pkgMarks = () => supaLog().filter((l) => l.rpc === "pkg_outbox_mark").map((l) => l.args.p_status);

Deno.test("R154g pkg-client-notify: SMTP only -> client e-mail sent (was skipped for good before), marked sent", async () => {
  pkgDb();
  const r = setEnv({ ...PKG_ENV, ...SMTP }); const smtp = installFakeSmtp(); const f = noFetch();
  try {
    const out = await (await (await loadHandler(PKG))(cron("cron-pkg"))).json();
    assertEquals(out.sent, 1);
    assertEquals(smtp.sent[0].rcpt, "<alice@client.test>");
    const p = partsOf(smtp.sent[0].data);
    assert(/From: "Helm" <owner@gmail\.com>/.test(p.headers), p.headers);
    assert(p.html.includes("https://www.helm.events/approve?token=" + TOK) && p.text.length > 0);
    assertEquals(pkgMarks(), ["sent"]);
  } finally { f(); smtp.restore(); r(); }
});

Deno.test("R154g pkg-client-notify: no provider -> released for retry (never skipped); Resend carries Idempotency-Key pkg-<id>", async () => {
  pkgDb();
  let r = setEnv(PKG_ENV); let f = noFetch();
  try {
    const out = await (await (await loadHandler(PKG))(cron("cron-pkg"))).json();
    assertEquals(out.no_provider, 1); assertEquals(out.skipped, 0);
    assertEquals(pkgMarks(), ["retry"]);
    assertEquals(fetchLog().length, 0);
  } finally { f(); r(); }
  pkgDb();
  r = setEnv({ ...PKG_ENV, ...RESEND, EMAIL_BRAND_MODE: "studio" });
  f = installFetch((url) => { if (url === "https://api.resend.com/emails") return jsonResponse({ id: "e" }); throw new Error(url); });
  try {
    await (await loadHandler(PKG))(cron("cron-pkg"));
    const call = fetchLog()[0];
    assertEquals((call.init?.headers as Record<string, string>)["Idempotency-Key"], "pkg-" + P1);
    assertEquals(JSON.parse(String(call.init?.body)).from, '"Studio A via Helm Events" <hello@helm.events>');
  } finally { f(); r(); }
});

// ======================= razorpay-webhook =======================
const RZP = "../../supabase/functions/razorpay-webhook/index.ts";
const QUOTE = "a0000000-0000-4000-8000-00000000da01";
const RZP_ENV = { ...BASE, RAZORPAY_WEBHOOK_SECRET: "whsec_test" };
async function signed(body: unknown): Promise<Request> {
  const raw = JSON.stringify(body);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("whsec_test"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return new Request("https://fn.local/", { method: "POST", headers: { "x-razorpay-signature": sig }, body: raw });
}
const PAID = { event: "payment_link.paid", payload: { payment_link: { entity: { id: "plink_A1", amount_paid: 23600000, notes: { quote_id: QUOTE } } }, payment: { entity: { id: "pay_A1", amount: 23600000 } } } };
function rzpDb() {
  resetSupaMock();
  g.__supaRpc = (name: string) => name === "razorpay_settle" ? { data: { result: "settled", quote_id: QUOTE }, error: null }
    : name === "studio_billing_email" ? { data: "owner@studio-a.in", error: null } : { data: null, error: null };
  g.__supaResolver = (table: string) => {
    if (table === "quotes") return { data: { id: QUOTE, code: "A-0001", title: "Wedding A", client: { email: "alice@example.com" }, pricing: { total: 236000 }, org_id: "org-a" }, error: null };
    if (table === "organizations") return { data: { name: "Studio A", business_email: "owner@studio-a.in" }, error: null };
    return { data: null, error: null };
  };
}
const notifRows = () => supaLog().filter((l) => l.table === "notifications").flatMap((l) => l.calls.filter((c: any) => c[0] === "insert").flatMap((c: any) => c[1][0]));

Deno.test("R154g razorpay-webhook: SMTP only -> receipts sent (studio name, text part), logged sent", async () => {
  rzpDb();
  const r = setEnv({ ...RZP_ENV, ...SMTP }); const smtp = installFakeSmtp(); const f = noFetch();
  try {
    assertEquals((await (await loadHandler(RZP))(await signed(PAID))).status, 200);
    assertEquals(smtp.sent.map((s) => s.rcpt).sort(), ["<alice@example.com>", "<owner@studio-a.in>"]);
    const p = partsOf(smtp.sent.find((s) => s.rcpt === "<alice@example.com>")!.data);
    assert(/From: "Studio A" <owner@gmail\.com>/.test(p.headers), p.headers);
    assert(/Reply-To: <owner@studio-a\.in>/i.test(p.headers), "reply goes to the studio");
    assert(p.text.includes("Payment received") && p.text.includes("Thank you") && !/<h2>/.test(p.text), p.text);
    assertEquals(notifRows().map((x: any) => x.status), ["sent", "sent"]);
  } finally { f(); smtp.restore(); r(); }
});

Deno.test("R154g razorpay-webhook: Resend key without RESEND_FROM -> simulated (no fallback sender, nothing sent), still 200", async () => {
  rzpDb();
  const r = setEnv({ ...RZP_ENV, RESEND_API_KEY: "re_test" }); const f = noFetch();
  try {
    const { result } = await captureConsoleError(async () => await (await loadHandler(RZP))(await signed(PAID)));
    assertEquals(result.status, 200);
    assertEquals(fetchLog().length, 0);
    assertEquals(notifRows().map((x: any) => x.status), ["simulated", "simulated"]);
  } finally { f(); r(); }
});

// ======================= comms-dispatch =======================
const COMMS = "../../supabase/functions/comms-dispatch/index.ts";
const C1 = "a0000000-0000-4000-8000-000000000001";
const COMMS_ENV = { ...BASE, HELM_COMMS_SECRET: "cron-comms", ...RESEND };
function commsDb(rpcs: string[] = []) {
  resetSupaMock();
  const marks: Record<string, string> = {};
  g.__supaRpc = (name: string, args: any) => {
    rpcs.push(name);
    if (name === "comms_outbox_claim") return { data: [{ id: C1, purpose: "invite_site", channel: "email", to: "client@example.com",
      payload: { body: "Hi Asha, here is your invitation website:", link_path: "i/asha-rahul", studio: "Sparkle" } }], error: null };
    if (name === "comms_outbox_email_identity") return { data: { from_name: "Sparkle Weddings", reply_to: "hello@sparkle.in" }, error: null };
    if (name === "comms_outbox_mark") { marks[args.p_id] = args.p_status; return { data: null, error: null }; }
    if (name === "welcome_email_switch") return { data: false, error: null };
    return { data: [], error: null };
  };
  return marks;
}
const resendOk = () => installFetch((url) => { if (url === "https://api.resend.com/emails") return jsonResponse({ id: "e" }); throw new Error(url); });

Deno.test("R154g comms-dispatch: Resend lane honours EMAIL_BRAND_MODE (default Helm Events; studio -> sender name) + Idempotency-Key", async () => {
  for (const [mode, from] of [[undefined, '"Helm Events" <hello@helm.events>'], ["studio", '"Sparkle Weddings" <hello@helm.events>']] as const) {
    const marks = commsDb();
    const r = setEnv({ ...COMMS_ENV, ...(mode ? { EMAIL_BRAND_MODE: mode } : {}) }); const f = resendOk();
    try {
      await (await loadHandler(COMMS))(cron("cron-comms"));
      const call = fetchLog().find((x) => x.url === "https://api.resend.com/emails")!;
      const b = JSON.parse(String(call.init?.body));
      assertEquals(b.from, from, "mode " + mode);
      assertEquals(b.reply_to, "hello@sparkle.in");
      assertEquals((call.init?.headers as Record<string, string>)["Idempotency-Key"], "comms-" + C1);
      assertEquals(marks[C1], "sent");
    } finally { f(); r(); }
  }
});

Deno.test("R154g comms-dispatch: RESEND_API_KEY without RESEND_FROM -> nothing sent (no onboarding@resend.dev)", async () => {
  commsDb();
  const r = setEnv({ ...COMMS_ENV, RESEND_FROM: "" }); const f = noFetch();
  try {
    await captureConsoleError(async () => await (await loadHandler(COMMS))(cron("cron-comms")));
    assertEquals(fetchLog().length, 0);
  } finally { f(); r(); }
});

Deno.test("R154g comms-dispatch: welcome lane - HELM_WELCOME_EMAILS_ENABLED 'true' or unset -> on (database switch decides), other values -> off", async () => {
  for (const [flag, on] of [[undefined, true], ["", true], ["true", true], [" true ", true], ["false", false], ["TRUE", false], ["0", false], ["off", false]] as const) {
    const rpcs: string[] = [];
    commsDb(rpcs);
    const r = setEnv({ ...COMMS_ENV, ...(flag === undefined ? {} : { HELM_WELCOME_EMAILS_ENABLED: flag }) }); const f = resendOk();
    try {
      const res = await (await loadHandler(COMMS))(cron("cron-comms"));
      assertEquals(res.status, 200);
      assertEquals(rpcs.includes("welcome_email_switch"), on, "flag " + JSON.stringify(flag));
      assert(!rpcs.includes("welcome_email_outbox_claim"), "database switch off -> nothing claimed");
    } finally { f(); r(); }
  }
});

// ======================= leftovers: comms-dispatch / welcome-mailer with no provider =======================
const EMAIL_LANES = ["trial_reminder_email_claim", "trial_retention_email_claim", "trial_followup_email_claim", "delivery_reminder_claim",
  "vendor_request_claim", "runsheet_reminder_claim", "enquiry_reply_claim", "helm_notice_outbox_claim", "welcome_email_switch", "welcome_email_outbox_claim"];

Deno.test("R154g comms-dispatch: no provider -> e-mail-only lanes NOT claimed; comms_outbox e-mail row -> retry (never skipped); WhatsApp lanes still run", async () => {
  for (const env of [{}, { RESEND_API_KEY: "re_test" }]) {   // nothing set / key without RESEND_FROM
    const rpcs: string[] = [];
    const marks = commsDb(rpcs);
    const r = setEnv({ ...BASE, HELM_COMMS_SECRET: "cron-comms", ...env }); const f = noFetch();
    try {
      const { result } = await captureConsoleError(async () => await (await loadHandler(COMMS))(cron("cron-comms")));
      const out = await result.json();
      assertEquals(out.no_provider, 1); assertEquals(out.skipped, 0);
      assertEquals(marks[C1], "retry");
      for (const lane of EMAIL_LANES) assert(!rpcs.includes(lane), lane + " must not be claimed");
      assert(rpcs.includes("comms_outbox_claim") && rpcs.includes("assign_notify_claim") && rpcs.includes("task_wa_claim"), "WhatsApp lanes still claimed");
      assertEquals(fetchLog().length, 0);
    } finally { f(); r(); }
  }
});

Deno.test("R154g comms-dispatch: provider set -> e-mail lanes claimed as before", async () => {
  const rpcs: string[] = [];
  commsDb(rpcs);
  const r = setEnv(COMMS_ENV); const f = resendOk();
  try {
    await (await loadHandler(COMMS))(cron("cron-comms"));
    for (const lane of EMAIL_LANES.slice(0, 9)) assert(rpcs.includes(lane), lane + " claimed");
  } finally { f(); r(); }
});

Deno.test("R154g welcome-mailer: no provider -> no_provider, switch + claim never called (nothing marked skipped)", async () => {
  resetSupaMock();
  const rpcs: string[] = [];
  g.__supaRpc = (name: string) => { rpcs.push(name); return name === "welcome_email_switch" ? { data: true, error: null } : { data: [], error: null }; };
  const r = setEnv({ ...BASE, HELM_WELCOME_EMAILS_ENABLED: "true", HELM_WELCOME_EMAIL_SECRET: "cron-w", RESEND_API_KEY: "re_test" }); const f = noFetch();
  try {
    const { result } = await captureConsoleError(async () => await (await loadHandler("../../supabase/functions/welcome-mailer/index.ts"))(cron("cron-w")));
    assertEquals((await result.json()).status, "no_provider");
    assertEquals(rpcs, []);
  } finally { f(); r(); }
});
