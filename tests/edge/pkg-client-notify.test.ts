// pkg-client-notify (0069) - dormant by default, shared-secret gate (fail closed), Resend +
// Meta Cloud API only, approval link only from /approve?token=<uuid>, idempotency key,
// retry on provider failure, no PII / codes in logs. Mock-only.
// R129 (0337): WhatsApp rows go out from the row's STUDIO's own connected number (helm_notice template); a studio
// without one -> skipped. Helm's own WHATSAPP_TOKEN / WHATSAPP_PHONE_ID (set in ON) are never used.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { setEnv, installFetch, jsonResponse, loadHandler, resetSupaMock, supaLog, fetchLog, captureConsoleError } from "./harness.ts";
import { approveLink, render } from "../../supabase/functions/pkg-client-notify/templates.ts";

const g = globalThis as any;
const FN = "../../supabase/functions/pkg-client-notify/index.ts";
const SECRET = "pkg-shared-secret";
const BASE = { SUPABASE_URL: "https://proj.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-secret" };
const ON = { ...BASE, HELM_PKG_NOTIFY_ENABLED: "true", HELM_PKG_NOTIFY_SECRET: SECRET, RESEND_API_KEY: "re_test", RESEND_FROM: "Helm <hello@helm.events>",
  WHATSAPP_TOKEN: "helm-own-wa-token", WHATSAPP_PHONE_ID: "1234567890" };   // Helm's own number: must never be used (R129)
const TOK = "a0000000-0000-4000-8000-0000000000aa";
const ID1 = "c0000000-0000-4000-8000-0000000069a1", ID2 = "c0000000-0000-4000-8000-0000000069a2", ID3 = "c0000000-0000-4000-8000-0000000069a3";
const req = (secret?: string) => new Request("https://fn.local/", { method: "POST", headers: secret === undefined ? {} : { "x-helm-cron-secret": secret } });
const marks = () => supaLog().filter((l) => l.rpc === "pkg_outbox_mark");
const noFetch = () => installFetch(() => { throw new Error("no fetch expected"); });

const ORG = "b0000000-0000-4000-8000-00000000da02";
const STUDIO_TOKEN = "studio-wa-token-0123456789abcdef", STUDIO_PHONE_ID = "1098765432";
const STUDIO_MESSAGES = `https://graph.facebook.com/v21.0/${STUDIO_PHONE_ID}/messages`;
// connected = the rows' studio has its own WhatsApp number (R129); every outbox row belongs to ORG
function db(rows: unknown[], connected = true) {
  g.__supaRpc = (name: string, args: any, key: string) => name === "pkg_outbox_claim" ? { data: rows, error: null }
    : name === "org_whatsapp_creds" ? (connected && key === "service-role-secret" && args?.p_org === ORG
      ? { data: { token: STUDIO_TOKEN, phone_number_id: STUDIO_PHONE_ID }, error: null } : { data: null, error: null })
    : { data: "ok", error: null };
  g.__supaResolver = (table: string) => table === "pkg_outbox" ? { data: { org_id: ORG }, error: null } : { data: null, error: null };
}
const accepted = { id: ID1, audience: "client", channel: "email", kind: "pkg_accepted", to: "alice@client.test",
  payload: { approve_url: "/approve?token=" + TOK, studio: "Studio <A>", client_name: "Alice Rao", title: "Wedding", total: 69620, paid: 20000, balance: 49620, currency: "INR", reapproval: true } };
const otp = { id: ID2, audience: "client", channel: "whatsapp", kind: "pkg_otp", to: "919876500000", payload: { otp: "123456", studio: "Studio A" } };
const staff = { id: ID3, audience: "staff", channel: "whatsapp", kind: "pkg_selected", to: "919848011111", payload: { package: "Gold Veg", guests: 100, code: "A-0001" } };

Deno.test("pkg-client-notify: dormant by default -> 200 no-op", async () => {
  resetSupaMock(); db([accepted]);
  const r = setEnv({ ...BASE, HELM_PKG_NOTIFY_SECRET: SECRET }); const f = noFetch();
  try {
    const res = await (await loadHandler(FN))(req(SECRET));
    assertEquals((await res.json()).status, "dormant"); assertEquals(supaLog().length, 0);
  } finally { f(); r(); }
});

for (const [name, env, given] of [["wrong secret", ON, "nope"], ["missing header", ON, undefined], ["secret unset", { ...ON, HELM_PKG_NOTIFY_SECRET: "" }, ""]] as const) {
  Deno.test(`pkg-client-notify: ${name} -> 401`, async () => {
    resetSupaMock(); db([accepted]);
    const r = setEnv(env as Record<string, string>); const f = noFetch();
    try {
      assertEquals((await (await loadHandler(FN))(req(given as string | undefined))).status, 401);
      assertEquals(supaLog().filter((l) => l.rpc).length, 0);
    } finally { f(); r(); }
  });
}

Deno.test("pkg-client-notify: e-mail + WhatsApp sent to fixed hosts, marked sent, no PII in logs", async () => {
  resetSupaMock(); db([accepted, otp, staff]);
  const r = setEnv(ON);
  const f = installFetch((url) => {
    if (url === "https://api.resend.com/emails" || url === STUDIO_MESSAGES) return jsonResponse({ id: "x" });
    throw new Error("unexpected " + url);
  });
  try {
    const { result, logs } = await captureConsoleError(async () => await (await loadHandler(FN))(req(SECRET)));
    assertEquals((await result.json()).sent, 3);
    const mail = fetchLog().find((x) => x.url.includes("resend"))!;
    const b = JSON.parse(String(mail.init?.body));
    assertEquals(b.to, ["alice@client.test"]);
    assert(b.html.includes("https://www.helm.events/approve?token=" + TOK));
    assert(b.html.includes("Studio &lt;A&gt;") && !b.html.includes("Studio <A>"));
    // the 2026-10 redesign put every Helm e-mail on _shared/email-layout.mjs (dark-mode friendly, like trial-reminder-email
    // and test/email-redesign); the old "light-only" check predates it. Owner decision on dark-mode e-mails still open.
    assert(/prefers-color-scheme:dark/.test(b.html), "shared e-mail layout");
    assertEquals((mail.init?.headers as Record<string, string>)["Idempotency-Key"], "pkg-" + ID1);
    // codeql[js/incomplete-url-substring-sanitization] -- false positive: filters a captured fetch log by expected host; not a security sanitizer on untrusted input.
    const waCalls = fetchLog().filter((x) => x.url.includes("graph.facebook.com"));
    const wa = waCalls.map((x) => JSON.parse(String(x.init?.body)));
    assertEquals(wa.length, 2);
    assert(wa.every((w) => w.type === "template" && w.template.name === "helm_notice"), "R129: the helm_notice template in the studio's account");
    assert(waCalls.every((x) => (x.init?.headers as Record<string, string>)["Authorization"] === "Bearer " + STUDIO_TOKEN), "the studio's own token, never Helm's");
    assert(marks().every((m) => m.args.p_status === "sent" && m.key === "service-role-secret"));
    const all = logs.join(" ");
    assert(!all.includes("alice@") && !all.includes("123456") && !all.includes("919876500000") && !all.includes(STUDIO_TOKEN));
  } finally { f(); r(); }
});

Deno.test("pkg-client-notify: bad approval path / studio WhatsApp not connected -> skipped, no fetch", async () => {
  resetSupaMock(); db([{ ...accepted, payload: { ...accepted.payload, approve_url: "https://evil.example/approve?token=" + TOK } }, otp], false);
  const r = setEnv(ON); const f = noFetch();   // Helm's own WHATSAPP_TOKEN is set: still never a fallback (R129)
  try {
    assertEquals((await (await (await loadHandler(FN))(req(SECRET))).json()).skipped, 2);
    assertEquals(fetchLog().length, 0);
    assert(marks().every((m) => m.args.p_status === "skipped"));
  } finally { f(); r(); }
});

Deno.test("pkg-client-notify: provider failure -> retry", async () => {
  resetSupaMock(); db([accepted]);
  const r = setEnv(ON); const f = installFetch(() => jsonResponse({ error: "x" }, 500));
  try {
    const { result } = await captureConsoleError(async () => await (await loadHandler(FN))(req(SECRET)));
    assertEquals((await result.json()).failed, 1);
    assertEquals(marks()[0].args.p_status, "retry");
  } finally { f(); r(); }
});

Deno.test("pkg-client-notify templates: approval link allowlist + escaping", () => {
  assertEquals(approveLink("/approve?token=" + TOK), "https://www.helm.events/approve?token=" + TOK);
  assertEquals(approveLink("/approve?token=x&next=//evil"), "");
  assertEquals(approveLink("javascript:alert(1)"), "");
  assertEquals(render("pkg_otp", { otp: "12ab56" }), null);
  const d = render("pkg_declined", { reason: "<b>full</b>", studio: "S" })!;
  assert(d.html.includes("&lt;b&gt;full&lt;/b&gt;"));
  assertEquals(render("unknown", {}), null);
});

// ---- 0155: last STOP check right before each WhatsApp send ----
Deno.test("pkg-client-notify: number replied STOP -> skipped, Meta never called; e-mail unaffected", async () => {
  resetSupaMock();
  db([accepted, otp]);
  const base = g.__supaRpc;
  g.__supaRpc = (name: string, a: unknown, k: string) => name === "wa_recipient_opted_out" ? { data: true, error: null } : base(name, a, k);
  const r = setEnv(ON);
  const f = installFetch((url) => {
    if (url === "https://api.resend.com/emails") return jsonResponse({ id: "x" });
    throw new Error("unexpected " + url);
  });
  try {
    const out = await (await (await loadHandler(FN))(req(SECRET))).json();
    assertEquals(out.sent, 1); assertEquals(out.skipped, 1);
    assertEquals(marks().find((m: any) => m.args.p_id === ID2)?.args.p_status, "skipped");
    assert(supaLog().some((l) => l.rpc === "wa_recipient_opted_out"));
  } finally { f(); r(); }
});

Deno.test("pkg-client-notify: STOP check fails -> WhatsApp row retried later, not sent", async () => {
  resetSupaMock();
  db([otp]);
  const base = g.__supaRpc;
  g.__supaRpc = (name: string, a: unknown, k: string) => name === "wa_recipient_opted_out" ? { data: null, error: { code: "PGRST202", message: "missing" } } : base(name, a, k);
  const r = setEnv(ON); const f = noFetch();
  try {
    await captureConsoleError(async () => await (await loadHandler(FN))(req(SECRET)));
    assertEquals(marks()[0]?.args.p_status, "retry");
  } finally { f(); r(); }
});
