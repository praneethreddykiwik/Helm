// send-otp — runtime-verified with mocked MSG91 + mocked Supabase RPCs.
// Audit Phase 8: destination comes from otp_send_authorize (client phone on file /
// Indian mobile, per-studio daily cap); DB errors never pass through to the caller.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  setEnv, installFetch, jsonResponse, textResponse, loadHandler, post,
  resetSupaMock, supaLog, fetchLog, captureConsoleError,
} from "./harness.ts";

const FN = "../../supabase/functions/send-otp/index.ts";
const g = globalThis as any;
const TOKEN = "a0000000-0000-4000-8000-0000000000aa";
const QUOTE = "a0000000-0000-4000-8000-00000000da01";

const BASE_ENV = {
  SUPABASE_URL: "https://proj.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-secret",
};
const LIVE_ENV = { ...BASE_ENV, MSG91_AUTHKEY: "ak", MSG91_SENDER: "HELMEV", MSG91_OTP_TEMPLATE_ID: "tpl" };

function rpcOk(dest = { quote_id: QUOTE, org_id: "o1", mobile: "919800000001" }) {
  g.__supaRpc = (name: string) => name === "otp_send_authorize" ? ({ data: dest, error: null }) : ({ data: { stored: true }, error: null });
  g.__supaResolver = () => ({ data: null, error: null });
}

Deno.test("send-otp: missing token/phone -> 400, malformed token -> 404", async () => {
  resetSupaMock();
  const rEnv = setEnv(BASE_ENV);
  const rF = installFetch(() => { throw new Error("no fetch expected"); });
  try {
    const h = await loadHandler(FN);
    assertEquals((await h(post({ phone: "9999999999" }))).status, 400);
    assertEquals((await h(post({ token: TOKEN }))).status, 400);
    assertEquals((await h(post({ token: "t", phone: "9999999999" }))).status, 404);
    assertEquals((await h(post({ token: TOKEN, phone: "123" }))).status, 400);
  } finally { rF(); rEnv(); }
});

Deno.test("send-otp: number NOT the client's phone on file -> refused, no code stored, no SMS", async () => {
  resetSupaMock();
  g.__supaRpc = (name: string) => name === "otp_send_authorize"
    ? ({ data: null, error: { code: "HL403", message: "phone not on file (secret detail)" } })
    : ({ data: { stored: true }, error: null });
  const rEnv = setEnv(LIVE_ENV);
  let fetched = false;
  const rF = installFetch(() => { fetched = true; return jsonResponse({}); });
  try {
    const h = await loadHandler(FN);
    const res = await h(post({ token: TOKEN, phone: "+91 99999 11111" }));
    assertEquals(res.status, 400);
    const body = await res.json();
    assert(!/secret detail|on file \(/.test(JSON.stringify(body)), "raw DB message must not leak");
    assert(!fetched, "MSG91 must not be called");
    assert(!supaLog().some((e) => e.rpc === "admin_store_otp"), "no OTP may be stored for a refused number");
  } finally { rF(); rEnv(); }
});

Deno.test("send-otp: per-studio SMS cap -> 429 generic", async () => {
  resetSupaMock();
  g.__supaRpc = () => ({ data: null, error: { code: "HL429", message: "sms limit reached" } });
  const rEnv = setEnv(LIVE_ENV);
  const rF = installFetch(() => { throw new Error("no fetch expected"); });
  try {
    const h = await loadHandler(FN);
    assertEquals((await h(post({ token: TOKEN, phone: "9800000001" }))).status, 429);
  } finally { rF(); rEnv(); }
});

Deno.test("send-otp: admin_store_otp error is mapped, never passed through", async () => {
  resetSupaMock();
  g.__supaRpc = (name: string) => name === "otp_send_authorize"
    ? ({ data: { quote_id: QUOTE, mobile: "919800000001" }, error: null })
    : ({ data: null, error: { code: "P0001", message: "relation quote_otps violates xyz internal" } });
  const rEnv = setEnv(LIVE_ENV);
  let fetched = false;
  const rF = installFetch(() => { fetched = true; return jsonResponse({}); });
  try {
    const h = await loadHandler(FN);
    const { result: res } = await captureConsoleError(() => Promise.resolve(h(post({ token: TOKEN, phone: "9800000001" }))));
    assertEquals(res.status, 400);
    const txt = JSON.stringify(await res.json());
    assert(!/quote_otps|internal/.test(txt), "DB error text leaked: " + txt);
    assert(!fetched);
  } finally { rF(); rEnv(); }
});

Deno.test("send-otp: SMS goes to the server-normalized number; log carries quote_id; code never returned", async () => {
  resetSupaMock();
  rpcOk();
  const rEnv = setEnv(LIVE_ENV);
  let sentTo = "";
  const rF = installFetch((url, init) => {
    assert(url.startsWith("https://control.msg91.com/"), "only MSG91 may be called");
    sentTo = JSON.parse(String(init?.body)).mobiles;
    return jsonResponse({ type: "success" });
  });
  try {
    const h = await loadHandler(FN);
    const res = await h(post({ token: TOKEN, phone: "098000 00001" }));
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.sent, true);
    assert(!("code" in body) && !("dev_code" in body), "OTP must never be returned");
    assertEquals(sentTo, "919800000001");
    const log = supaLog().find((e) => e.table === "notifications");
    assert(log, "notification must be logged");
    const row = log.calls.find((c: any) => c[0] === "insert")[1][0];
    assertEquals(row.quote_id, QUOTE);
    assertEquals(row.status, "sent");
  } finally { rF(); rEnv(); }
});

Deno.test("send-otp: provider (MSG91) unavailable -> 502 generic, provider body not logged", async () => {
  resetSupaMock();
  rpcOk();
  const rEnv = setEnv(LIVE_ENV);
  const rF = installFetch(() => textResponse("MSG91 secret failure detail XYZ for 919800000001", 500));
  try {
    const h = await loadHandler(FN);
    const { result: res, logs } = await captureConsoleError(() => Promise.resolve(h(post({ token: TOKEN, phone: "9800000001" }))));
    assertEquals(res.status, 502);
    const txt = JSON.stringify(await res.json());
    assert(!txt.includes("XYZ"));
    assert(!logs.join(" ").includes("919800000001"), "phone numbers must not reach the logs");
  } finally { rF(); rEnv(); }
});

Deno.test("send-otp: simulated (no MSG91 key) -> no provider call, logged as simulated", async () => {
  resetSupaMock();
  rpcOk();
  const rEnv = setEnv(BASE_ENV);
  const rF = installFetch(() => { throw new Error("no fetch expected"); });
  try {
    const h = await loadHandler(FN);
    const res = await h(post({ token: TOKEN, phone: "9800000001" }));
    assertEquals(res.status, 200);
    assertEquals((await res.json()).live, false);
    assertEquals(fetchLog().length, 0);
  } finally { rF(); rEnv(); }
});

// R258 (0445): the code of the client's "Pay this payment" step - its own table, never an approval code
const MS = "a0000000-0000-4000-8000-000000445201";
const payCalls = (begin: unknown, beginErr: unknown = null) => { g.__supaRpc = (name: string) =>
  name === "payment_code_begin" ? ({ data: begin, error: beginErr }) : name === "trial_send_blocked" ? ({ data: false, error: null }) : ({ data: null, error: null }); g.__supaResolver = () => ({ data: null, error: null }); };
Deno.test("send-otp R258: payment code e-mailed to the address on the quote, kept in payment_codes, never admin_store_otp", async () => {
  resetSupaMock(); payCalls({ id: "c1", quote_id: QUOTE, org_id: "o1", email: "rohan@example.com", masked: "r***@example.com", resends_left: 3 });
  const rEnv = setEnv({ ...BASE_ENV, RESEND_API_KEY: "re_x", RESEND_FROM: "Helm <no-reply@helm.events>" });
  let body = "";
  const rF = installFetch((_u: unknown, init: any) => { body = String(init?.body || ""); return jsonResponse({ id: "m1" }); });
  try {
    const h = await loadHandler(FN), res = await h(post({ token: TOKEN, channel: "pay_email", milestone: MS, email: "evil@example.com" })), j = await res.json();
    assertEquals(res.status, 200); assertEquals(j.live, true); assertEquals(j.masked, "r***@example.com"); assert(!("code" in j));
    const names = supaLog().filter((x: any) => x.rpc || x.name).map((x: any) => x.rpc || x.name);
    const all = JSON.stringify(supaLog());
    assert(all.includes("payment_code_begin") && all.includes("payment_code_set") && all.includes("payment_code_sent")); assert(!all.includes("admin_store_otp"), names.join());
    assert(body.includes("rohan@example.com") && body.includes("Your payment code") && !body.includes("evil@example.com") && !body.includes("approve your event"));
  } finally { rF(); rEnv(); }
});
Deno.test("send-otp R258: no mail sender = not live and not marked as sent; refusals are plain; bad payment id refused", async () => {
  resetSupaMock(); payCalls({ id: "c1", quote_id: QUOTE, org_id: "o1", email: "rohan@example.com", masked: "r***@example.com", resends_left: 3 });
  const rEnv = setEnv(BASE_ENV), rF = installFetch(() => { throw new Error("no fetch expected"); });
  try {
    const h = await loadHandler(FN), j = await (await h(post({ token: TOKEN, channel: "pay_email", milestone: MS }))).json();
    assertEquals(j.live, false); assert(!JSON.stringify(supaLog()).includes("payment_code_sent"));
    // (a link of its own per try: 5 a minute per link)
    for (const [code, status] of [["HL404", 404], ["HL403", 400], ["HL429", 429], ["XX000", 400]] as const) {
      resetSupaMock(); payCalls(null, { code, message: "secret detail" });
      const r = await h(post({ token: TOKEN.slice(0, -1) + String(status % 7) + "", channel: "pay_email", milestone: MS })); assertEquals(r.status, status); assert(!(await r.text()).includes("secret"));
    }
    resetSupaMock(); payCalls(null);
    assertEquals((await h(post({ token: TOKEN.replace(/aa$/, "ab"), channel: "pay_email" }))).status, 400);
    assertEquals((await h(post({ token: "t", channel: "pay_email", milestone: MS }))).status, 404);
    resetSupaMock(); g.__supaRpc = (n: string) => n === "trial_send_blocked" ? ({ data: true, error: null }) : ({ data: null, error: null });
    assertEquals((await h(post({ token: TOKEN.replace(/aa$/, "ac"), channel: "pay_email", milestone: MS }))).status, 403); assert(!JSON.stringify(supaLog()).includes("payment_code_begin"));
  } finally { rF(); rEnv(); }
});
