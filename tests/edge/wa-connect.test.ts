// wa-connect - R154h: the connection check answers a short reason CODE the Integrations page can explain (bad token,
// wrong phone number id, wrong WhatsApp Business Account ID, missing permissions, number not in the account, nothing
// saved yet, Meta too slow) - codes and Meta error numbers only, never the token. Meta (graph.facebook.com) and Supabase
// are mocked: no network, no DB. The saved token goes only to graph.facebook.com and is never in an answer or a log.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { setEnv, installFetch, jsonResponse, loadHandler, post, resetSupaMock, supaLog, captureConsoleError, fetchLog } from "./harness.ts";

const FN = "../../supabase/functions/wa-connect/index.ts";
const g = globalThis as any;
const ENV = { SUPABASE_URL: "https://proj.supabase.co", SUPABASE_ANON_KEY: "anon-key", SUPABASE_SERVICE_ROLE_KEY: "service-role-secret", WHATSAPP_API_VERSION: "v21.0" };
const AUTH = { authorization: "Bearer user-jwt" };
const ORG = "a0000000-0000-4000-8000-000000000001";
const TOKEN = "studio-wa-token-r154h-0123456789abcdef";
const PHONE = "2000000353", WABA = "1000000353";
const G = "https://graph.facebook.com/v21.0/";

type Meta = { phone?: [number, unknown]; list?: [number, unknown] };
function db(opts: { admin?: boolean; creds?: unknown } = {}) {
  const { admin = true } = opts;
  const creds = "creds" in opts ? opts.creds : { org_id: ORG, waba_id: WABA, phone_number_id: PHONE, status: "pending", token: TOKEN };
  g.__supaGetUser = (jwt: string) => jwt === "user-jwt" ? { data: { user: { id: "u-admin" } } } : { data: { user: null } };
  g.__supaRpc = (name: string, _args: any, key: string) => {
    if (name === "wa_connect_org") return admin && key === "anon-key" ? { data: ORG, error: null } : { data: null, error: { code: "42501", message: "not_allowed" } };
    if (name === "org_whatsapp_check_creds") return key === "service-role-secret" ? { data: creds, error: null } : { data: null, error: { code: "42501" } };
    if (name === "wa_account_verified") return { data: { result: "ok" }, error: null };
    if (name === "wa_templates_mark") return { data: null, error: null };
    return { data: null, error: null };
  };
}
// jsonResponse(body, status): the tuples above are [status, body] - flip them
function jr(t: [number, unknown] | undefined, def: unknown): [unknown, number] { return t ? [t[1], t[0]] : [def, 200]; }
function metaMock(m: Meta) {
  return installFetch((url) => {
    if (!url.startsWith("https://graph.facebook.com/")) throw new Error("unexpected host " + url);
    if (url.startsWith(G + PHONE + "?")) return jsonResponse(...jr(m.phone, { id: PHONE, display_phone_number: "+91 90000 00353", verified_name: "Studio A", quality_rating: "GREEN" }));
    if (url.startsWith(G + WABA + "/phone_numbers")) return jsonResponse(...jr(m.list, { data: [{ id: PHONE }] }));
    if (url.startsWith(G + WABA + "/subscribed_apps")) return jsonResponse({ success: true });
    if (url.startsWith(G + WABA + "/message_templates")) return jsonResponse({ data: [] });
    throw new Error("unexpected Meta call " + url);
  });
}
async function verify(m: Meta, dbOpts: { admin?: boolean; creds?: unknown } = {}) {
  resetSupaMock(); db(dbOpts);
  const rEnv = setEnv(ENV), rF = metaMock(m);
  try {
    const { result: res, logs } = await captureConsoleError(async () => await (await loadHandler(FN))(post({ action: "verify" }, AUTH)));
    const text = await res.text();
    return { status: res.status, body: JSON.parse(text), text, logs, calls: fetchLog().slice() };
  } finally { rF(); rEnv(); }
}
function noSecret(r: { text: string; logs: string[]; calls: { url: string }[] }) {
  assert(!r.text.includes(TOKEN) && !r.text.includes(TOKEN.slice(-4) + '"'), "the answer never carries the token");
  assert(!r.logs.join("\n").includes(TOKEN), "the logs never carry the token");
  for (const c of r.calls) { assert(c.url.startsWith("https://graph.facebook.com/")); assert(!c.url.includes(TOKEN), "token never in a URL"); }
}
const marked = () => supaLog().find((e) => e.rpc === "wa_account_verified")?.args as any;

Deno.test("wa-connect verify: connected - number + name, token only in the Authorization header to Meta", async () => {
  const r = await verify({});
  assertEquals(r.status, 200);
  assertEquals([r.body.ok, r.body.status, r.body.display_phone, r.body.verified_name], [true, "connected", "+91 90000 00353", "Studio A"]);
  assertEquals(marked().p_ok, true);
  assertEquals(String((r.calls[0] as any).init.headers.Authorization), "Bearer " + TOKEN);
  noSecret(r);
});

Deno.test("wa-connect verify: a bad / expired token -> code token, recorded as error, no secret", async () => {
  const r = await verify({ phone: [401, { error: { code: 190, message: "Invalid OAuth access token " + TOKEN } }] });
  assertEquals([r.status, r.body.ok, r.body.status, r.body.code], [200, false, "error", "token"]);
  assert(/access token/.test(r.body.error));
  assertEquals([marked().p_ok, /access token/.test(marked().p_error)], [false, true]);
  assert(!String(marked().p_error).includes(TOKEN), "the saved reason never carries the token");
  noSecret(r);
});

Deno.test("wa-connect verify: a wrong phone number ID -> code number", async () => {
  const r = await verify({ phone: [400, { error: { code: 100, error_subcode: 33, message: "Unsupported get request" } }] });
  assertEquals([r.body.ok, r.body.code], [false, "number"]);
  assert(/phone number ID/.test(r.body.error));
  noSecret(r);
});

Deno.test("wa-connect verify: missing whatsapp_business_* permission -> code permission", async () => {
  const r = await verify({ phone: [403, { error: { code: 200, message: "Permissions error" } }] });
  assertEquals([r.body.ok, r.body.code], [false, "permission"]);
  assert(/whatsapp_business_messaging/.test(r.body.error));
  const r2 = await verify({ phone: [400, { error: { code: 10, message: "Application does not have permission" } }] });
  assertEquals(r2.body.code, "permission");
});

Deno.test("wa-connect verify: a wrong WhatsApp Business Account ID -> code waba (the phone answered)", async () => {
  const r = await verify({ list: [400, { error: { code: 100, message: "Unsupported get request" } }] });
  assertEquals([r.body.ok, r.body.code], [false, "waba"]);
  assert(/WhatsApp Business Account ID/.test(r.body.error), r.body.error);
  noSecret(r);
});

Deno.test("wa-connect verify: the phone number ID is not in that account -> code not_in_account", async () => {
  const r = await verify({ list: [200, { data: [{ id: "2999999999" }] }] });
  assertEquals([r.body.ok, r.body.code], [false, "not_in_account"]);
  assertEquals(marked().p_ok, false);
});

Deno.test("wa-connect verify: IDs saved but no token yet -> 409 details_missing, Meta never asked", async () => {
  const r = await verify({}, { creds: null });
  assertEquals([r.status, r.body.ok, r.body.code], [409, false, "details_missing"]);
  assertEquals(r.calls.length, 0);
  assert(!supaLog().some((e) => e.rpc === "wa_account_verified"), "nothing recorded");
});

Deno.test("wa-connect verify: not the studio admin -> 403, nothing read, Meta never asked", async () => {
  const r = await verify({}, { admin: false });
  assertEquals(r.status, 403);
  assertEquals(r.calls.length, 0);
  assert(!supaLog().some((e) => e.rpc === "org_whatsapp_check_creds"));
});

Deno.test("wa-connect: templates before a passed check -> 409 not_checked", async () => {
  resetSupaMock(); db();
  const rEnv = setEnv(ENV), rF = metaMock({});
  try {
    const res = await (await loadHandler(FN))(post({ action: "templates" }, AUTH));
    const b = await res.json();
    assertEquals([res.status, b.code], [409, "not_checked"]);
    assertEquals(fetchLog().length, 0);
  } finally { rF(); rEnv(); }
});

// ---- R156 (0354): Set up message templates in the background -------------------------------------------------------------
function connectedDb(extra: (name: string, args: any, key: string) => unknown = () => undefined) {
  db({ creds: { org_id: ORG, waba_id: WABA, phone_number_id: PHONE, status: "connected", token: TOKEN } });
  const base = g.__supaRpc;
  g.__supaRpc = (name: string, args: any, key: string) => { const x = extra(name, args, key); return x === undefined ? base(name, args, key) : x; };
}
async function action(body: Record<string, unknown>, list: unknown[], creates: (b: any) => [number, unknown] = () => [200, { id: "1", status: "PENDING" }]) {
  const rEnv = setEnv(ENV);
  const rF = installFetch((url, init) => {
    if (!url.startsWith("https://graph.facebook.com/")) throw new Error("unexpected host " + url);
    if (url.startsWith(G + WABA + "/message_templates?")) return jsonResponse({ data: list });
    if (url === G + WABA + "/message_templates" && init?.method === "POST") { const [s, b] = creates(JSON.parse(String(init.body))); return jsonResponse(b, s); }
    throw new Error("unexpected Meta call " + url);
  });
  try {
    const { result: res, logs } = await captureConsoleError(async () => await (await loadHandler(FN))(post(body, AUTH)));
    const text = await res.text();
    return { status: res.status, body: JSON.parse(text), text, logs, calls: fetchLog().slice() };
  } finally { rF(); rEnv(); }
}

Deno.test("wa-connect templates (0354): queues ONLY the missing names and answers at once - no create inside the request", async () => {
  resetSupaMock();
  let queued: any = null;
  connectedDb((name, args) => {
    if (name === "wa_template_enqueue") { queued = args; return { data: { ok: true, queued: args.p_items.length, batch_id: "b" }, error: null }; }
    if (name === "my_wa_template_setup") return { data: { running: true, jobs: [] }, error: null };
  });
  const r = await action({ action: "templates" }, [{ name: "proposal_sent", language: "en", status: "APPROVED", category: "UTILITY", id: "9" }]);
  assertEquals(r.status, 200);
  assertEquals([r.body.ok, r.body.background, r.body.setup.running], [true, true, true]);
  assert(!r.calls.some((c: any) => c.init?.method === "POST"), "nothing created in the request");
  const names = queued.p_items.map((x: any) => x.name);
  assert(!names.includes("proposal_sent"), "a template already in the account is never queued");
  assertEquals(names.length, 20);
  assert(queued.p_items.every((x: any) => x.language === "en"));
  assertEquals(queued.p_user, "u-admin");
  assert(supaLog().some((e) => e.rpc === "wa_template_sync" && e.key === "service-role-secret"), "review facts recorded");
  noSecret(r);
});

Deno.test("wa-connect templates on a database without 0354: created here, Meta's real reason per template (no 'try again later')", async () => {
  resetSupaMock();
  connectedDb((name) => { if (name === "wa_template_enqueue") return { data: null, error: { code: "PGRST202", message: "not found" } }; });
  const r = await action({ action: "templates" }, [], (b) => b.name === "vendor_request"
    ? [400, { error: { code: 100, error_subcode: 2388293, error_user_title: "Too many variables", error_user_msg: "Too many variables for its length " + TOKEN } }]
    : b.name === "proposal_approval_otp" ? [400, { error: { code: 200, message: "This WhatsApp business account does not have permission to create message template" } }]
    : [200, { id: "1", status: "PENDING" }]);
  assertEquals(r.body.ok, true);
  assertEquals(r.body.created, 19);
  const byName = Object.fromEntries(r.body.failed.map((f: any) => [f.name, f]));
  assertEquals([byName.vendor_request.reason, byName.vendor_request.code, byName.vendor_request.subcode], ["ratio", 100, 2388293]);
  assertEquals(byName.proposal_approval_otp.reason, "auth_not_eligible");
  assert(!byName.vendor_request.message.includes(TOKEN.slice(0, 20)), "Meta's message is cleaned");
  noSecret(r);
});

Deno.test("wa-connect resubmit: as the caller (the database checks admin + own studio), the worker does the Meta call", async () => {
  resetSupaMock();
  connectedDb((name, args, key) => {
    if (name === "wa_template_resubmit") return key === "anon-key" && args.p_name === "vendor_request" ? { data: { ok: true, name: "vendor_request" }, error: null } : { data: null, error: { code: "22023", message: "not_resubmittable" } };
  });
  const r = await action({ action: "resubmit", name: "vendor_request" }, []);
  assertEquals([r.status, r.body.ok, r.body.background, r.body.resubmitted], [200, true, true, "vendor_request"]);
  assertEquals(r.calls.length, 0, "no Meta call in the request");
  const r2 = await action({ action: "resubmit", name: "proposal_sent" }, []);
  assertEquals([r2.status, r2.body.code], [409, "not_resubmittable"]);
  const r3 = await action({ action: "resubmit", name: "Bad Name" }, []);
  assertEquals(r3.status, 400);
});
