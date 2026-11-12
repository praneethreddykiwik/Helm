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
