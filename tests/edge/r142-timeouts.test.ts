// R142 edge hardening: provider deadlines (_shared/http.ts + SMTP connect), one Sentry event per request
// (sentryOnce), JSON log lines (_shared/log.ts). Mock-only: fetch / Deno.connect are replaced, NO network.
import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { captureConsoleError, installFetch, jsonResponse, loadHandler, resetSupaMock, setEnv } from "./harness.ts";
import { fetchWithTimeout, isTimeout, withDeadline } from "../../supabase/functions/_shared/http.ts";
import { logLine, requestId } from "../../supabase/functions/_shared/log.ts";
import { errTag, sentryOnce } from "../../supabase/functions/_shared/cors.ts";
import { sendMail } from "../../supabase/functions/_shared/mailer.ts";
import { smtpReason, smtpSend } from "../../supabase/functions/_shared/smtp.ts";
import { waPost } from "../../supabase/functions/_shared/wa-sender.ts";

const g = globalThis as any;
const DSN = "https://0123456789abcdef0123456789abcdef@o9.ingest.de.sentry.io/5";
const SENTRY = "https://o9.ingest.de.sentry.io/api/5/envelope/";
const timeoutErr = () => new DOMException("Signal timed out.", "TimeoutError");
// a fetch that never answers on its own, but honours the signal like the real one
const hangingFetch = (_u: unknown, init?: RequestInit) =>
  new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true }));

Deno.test("http: fetchWithTimeout gives up after its deadline with a TimeoutError", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = hangingFetch as any;
  try {
    const t0 = Date.now();
    const e = await assertRejects(() => fetchWithTimeout("https://api.resend.com/emails", { method: "POST" }, 40));
    assert(isTimeout(e), String(e));
    assertEquals(errTag(e), "TimeoutError");   // readable tag, not the DOMException legacy code 23
    assert(Date.now() - t0 < 2000);
  } finally { globalThis.fetch = orig; }
});

Deno.test("http: the caller's own signal still works (AbortError, not a timeout); the global fetch is used at call time", async () => {
  const orig = globalThis.fetch;
  const seen: RequestInit[] = [];
  globalThis.fetch = ((u: unknown, init?: RequestInit) => { seen.push(init!); return hangingFetch(u, init); }) as any;
  try {
    const c = new AbortController();
    setTimeout(() => c.abort(), 10);
    const e = await assertRejects(() => fetchWithTimeout("https://graph.facebook.com/x", { signal: c.signal, redirect: "error" }, 5000));
    assert(!isTimeout(e));
    assertEquals((e as Error).name, "AbortError");
    assertEquals(seen[0].redirect, "error", "the caller's init is passed through");
  } finally { globalThis.fetch = orig; }
});

Deno.test("http: withDeadline closes a connection that opens after the deadline", async () => {
  let open!: (v: { close(): void }) => void;
  let closed = false;
  const late = new Promise<{ close(): void }>((r) => { open = r; });
  const e = await assertRejects(() => withDeadline(late, 20, (c) => c.close()));
  assert(isTimeout(e));
  open({ close: () => { closed = true; } });
  await new Promise((r) => setTimeout(r, 0));
  assert(closed, "late connection closed");
});

Deno.test("smtp: a server that never answers the connect fails at stage 'connect' within the deadline", async () => {
  let open!: (v: unknown) => void;
  let closed = false;
  const cfg = { host: "smtp.example.com", port: 465, user: "u@example.com", pass: "app-pass-secret", tls: true };
  const t0 = Date.now();
  const e = await assertRejects(() => smtpSend(cfg, { from: "u@example.com", to: "c@example.com", subject: "s", text: "t" },
    { connect: () => new Promise((r) => { open = r; }) as any, connectTimeoutMs: 30 }));
  assertEquals((e as any).stage, "connect");
  assert(/TimeoutError/.test((e as Error).message));
  assert(!/app-pass-secret/.test((e as Error).message));
  assert(/could not connect to the mail server/.test(smtpReason(e)));
  assert(Date.now() - t0 < 2000);
  open({ close: () => { closed = true; }, read: () => Promise.resolve(null), write: (d: Uint8Array) => Promise.resolve(d.length) });
  await new Promise((r) => setTimeout(r, 0));
  assert(closed, "the connection that opened too late is closed");
});

Deno.test("mailer: a Resend timeout is the same 'could not be reached' failure; the log line is JSON without the address", async () => {
  const rEnv = setEnv({ RESEND_API_KEY: "re_test", RESEND_FROM: "Helm <hello@helm.events>" });
  const rF = installFetch(() => { throw timeoutErr(); });
  try {
    const { result, logs } = await captureConsoleError(() => sendMail({ to: "client@example.com", subject: "Hi", text: "Hello" }));
    assertEquals(result, { status: "failed", provider: "resend", reason: "the e-mail provider could not be reached" });
    const line = JSON.parse(logs.find((l) => l.includes("resend unreachable"))!);
    assertEquals(line.level, "error"); assertEquals(line.fn, "mailer"); assertEquals(line.code, "TimeoutError");
    assert(!logs.join(" ").includes("client@example.com"));
  } finally { rF(); rEnv(); }
});

Deno.test("wa-sender: a Meta timeout - before OR while reading the answer - is 'could not reach WhatsApp' (row retried)", async () => {
  const sender = { source: "studio" as const, orgId: null, phoneId: "1234567890", token: "EAAG" + "x".repeat(40), wabaId: "" };
  for (const responder of [
    () => { throw timeoutErr(); },
    () => new Response(new ReadableStream({ start(c) { c.error(timeoutErr()); } }), { status: 200 }),
  ]) {
    const rF = installFetch(responder as any);
    try {
      const { result, logs } = await captureConsoleError(() => waPost(null, sender, { to: "919876543210", type: "text", text: { body: "x" } }));
      assertEquals(result, { ok: false, status: 0, wamid: null, kind: "other", text: "could not reach WhatsApp" });
      assert(!logs.join(" ").includes("919876543210") && !logs.join(" ").includes(sender.token), "no phone / token in logs");
    } finally { rF(); }
  }
});

Deno.test("log: JSON line with level / fn / msg / code / req; private-looking values are never printed", () => {
  const req = new Request("https://fn.local/", { headers: { "sb-request-id": "0b6c3f0e-1111-4222-8333-944445555666" } });
  assertEquals(requestId(req), "0b6c3f0e-1111-4222-8333-944445555666");
  assertEquals(requestId(new Request("https://fn.local/", { headers: { "x-request-id": "bad id@x" } })), undefined);
  const o = JSON.parse(logLine("error", "comms-dispatch", "mark failed", "PGRST202",
    { lane: "trial", sent: 3, email: "a@b.in", phone: "919876543210", token: "9f86d081884c7d659a2feaa0c55ad015", why: "magic bytes do not match" }, requestId(req)));
  assertEquals(o, { level: "error", fn: "comms-dispatch", msg: "mark failed", code: "PGRST202", req: "0b6c3f0e-1111-4222-8333-944445555666",
    lane: "trial", sent: 3, email: "?", phone: "?", token: "?", why: "magic bytes do not match" });
  assertEquals(JSON.parse(logLine("error", "x", "m", "919876543210")).code, "?", "a phone number is never a code");
  assertEquals(JSON.parse(logLine("info", "x", "run", undefined, { sent: 1e12 })).sent, "?");
});

Deno.test("sentryOnce: at most ONE event per request; function name + tag only; off without SENTRY_DSN", async () => {
  const req = new Request("https://proj.supabase.co/functions/v1/comms-dispatch", { method: "POST" });
  let rEnv = setEnv({});
  const rF = installFetch(() => jsonResponse({}));
  try {
    sentryOnce(req).error(new Error("boom for a@b.in"));
    assertEquals(g.__fetchLog.length, 0, "nothing sent without the secret");
    rEnv(); rEnv = setEnv({ SENTRY_DSN: DSN });
    const report = sentryOnce(req);
    report.fail("send_failed"); report.error(Object.assign(new Error("x"), { code: "23505" })); report.fail("send_failed");
    assertEquals(g.__fetchLog.length, 1);
    assertEquals(g.__fetchLog[0].url, SENTRY);
    const body = String(g.__fetchLog[0].init.body);
    assert(/"function":"comms-dispatch"/.test(body) && /"type":"send_failed"/.test(body), body);
    sentryOnce(req).fail("Not A Kind @x");   // a new request may send its own event; a bad kind becomes "failure"
    assert(/"type":"failure"/.test(String(g.__fetchLog[1].init.body)));
  } finally { rF(); rEnv(); }
});

Deno.test("comms-dispatch: Resend timing out on every row -> rows back to retry, answer 200, ONE Sentry event for the batch", async () => {
  const ID1 = "a0000000-0000-4000-8000-000000000001", ID2 = "a0000000-0000-4000-8000-000000000002";
  resetSupaMock();
  const marks: Record<string, string> = {};
  g.__supaRpc = (name: string, args: any) => {
    if (name === "comms_outbox_claim") return { data: [
      { id: ID1, purpose: "invite_site", channel: "email", to: "client@example.com", payload: { body: "Hi Asha, here is your invitation website:", link_path: "i/asha-rahul", studio: "Sparkle" } },
      { id: ID2, purpose: "invite_site", channel: "email", to: "other@example.com", payload: { body: "Hi Ravi, here is your invitation website:", link_path: "i/ravi-meera", studio: "Sparkle" } },
    ], error: null };
    if (name === "comms_outbox_mark") { marks[args.p_id] = args.p_status; return { data: null, error: null }; }
    return { data: [], error: null };
  };
  const rEnv = setEnv({ SUPABASE_URL: "https://proj.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-secret", HELM_COMMS_SECRET: "cron-xyz",
    APP_URL: "https://www.helm.events", RESEND_API_KEY: "re_test", RESEND_FROM: "Helm <hello@helm.events>", SENTRY_DSN: DSN });
  const rF = installFetch((url) => { if (url.startsWith("https://api.resend.com/")) throw timeoutErr(); return jsonResponse({}); });
  try {
    const h = await loadHandler("../../supabase/functions/comms-dispatch/index.ts");
    const { result, logs } = await captureConsoleError(async () =>
      await h(new Request("https://proj.supabase.co/functions/v1/comms-dispatch", { method: "POST", headers: { "x-helm-cron-secret": "cron-xyz", "sb-request-id": "req-r142-0001" } })));
    assertEquals(result.status, 200);
    const out = await result.json();
    assertEquals(out.failed, 2);
    assertEquals(marks, { [ID1]: "retry", [ID2]: "retry" });
    const sentry = g.__fetchLog.filter((f: any) => f.url === SENTRY);
    assertEquals(sentry.length, 1, "one event for the whole batch");
    const body = String(sentry[0].init.body);
    assert(/"function":"comms-dispatch"/.test(body) && /"type":"send_failed"/.test(body), body);
    assert(!/example\.com|Sparkle|Asha|Ravi|asha/.test(body), "no PII in the event");
    const lines = logs.map((l) => { try { return JSON.parse(l); } catch (_) { return {}; } });
    // R154g: comms-dispatch sends through the shared mailer, which logs the timeout (no address)
    assert(lines.some((l) => l.fn === "mailer" && l.msg === "resend unreachable" && l.code === "TimeoutError"));
    assert(lines.some((l) => l.fn === "comms-dispatch" && l.msg === "email failed"));
    assert(!logs.join(" ").includes("example.com"), "no address in logs");
  } finally { rF(); rEnv(); resetSupaMock(); }
});
