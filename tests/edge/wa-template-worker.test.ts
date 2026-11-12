// wa-template-worker - R156 (0354): the background setup of a studio's WhatsApp templates. Meta (graph.facebook.com) and
// Supabase are mocked: no network, no DB. Proves: cron secret required; a template already in the account is never created
// again (no duplicate); Helm's wording is created otherwise; Meta's wording refusal is kept with its code (no token, no link);
// the Template Library version is used when an entry fits and Helm's wording when the library call fails; the approval-code
// template on an unverified business = auth_not_eligible; a Meta rate limit pauses the studio (nothing else is sent);
// a temporary failure is retried; Fix and resubmit edits the rejected template in place; a category change is reported;
// the number's health is read (read-only) and recorded; the token never leaves the Authorization header.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { setEnv, installFetch, jsonResponse, loadHandler, resetSupaMock, supaLog, captureConsoleError, fetchLog } from "./harness.ts";

const FN = "../../supabase/functions/wa-template-worker/index.ts";
const g = globalThis as any;
const SECRET = "cron-secret-r156-0123456789";
const ENV = { SUPABASE_URL: "https://proj.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-secret", HELM_WA_TEMPLATE_SECRET: SECRET, WHATSAPP_API_VERSION: "v21.0", APP_URL: "https://www.helm.events" };
const ORG = "a0000000-0000-4000-8000-000000000001";
const TOKEN = "studio-wa-token-r156-0123456789abcdef";
const PHONE = "2000000356", WABA = "1000000356";
const G = "https://graph.facebook.com/v21.0/";
let n = 0;
const job = (name: string, extra: Record<string, unknown> = {}) => ({ id: `0000000${++n % 10}-0000-4000-8000-${String(n).padStart(12, "0")}`, name, language: "en", action: "create", variant: "own", meta_id: null, attempts: 0, ...extra });

type Db = { jobs: any[]; recorded: Record<string, any>; synced?: any; health?: any; notices: any[]; creds?: unknown; healthAt?: string | null };
function db(jobs: any[], opts: { creds?: unknown; recategorised?: unknown[]; healthAt?: string | null } = {}): Db {
  const d: Db = { jobs, recorded: {}, notices: [], healthAt: "healthAt" in opts ? opts.healthAt : new Date().toISOString() };
  const creds = "creds" in opts ? opts.creds : { org_id: ORG, waba_id: WABA, phone_number_id: PHONE, status: "connected", token: TOKEN };
  g.__supaRpc = (name: string, args: any, key: string) => {
    if (key !== "service-role-secret") return { data: null, error: { code: "42501" } };
    if (name === "wa_template_due_orgs") return { data: [ORG], error: null };
    if (name === "org_whatsapp_check_creds") return { data: creds, error: null };
    if (name === "wa_template_sync") { d.synced = args; return { data: { changed: 0, recategorised: opts.recategorised || [] }, error: null }; }
    if (name === "wa_template_category_notice") { d.notices.push(args); return { data: true, error: null }; }
    if (name === "wa_templates_mark") return { data: null, error: null };
    if (name === "wa_template_claim") return { data: d.jobs, error: null };
    if (name === "wa_template_record") { d.recorded[(d.jobs.find((j) => j.id === args.p_id) || {}).name] = args.p_result; return { data: { result: "ok" }, error: null }; }
    if (name === "wa_template_finish") return { data: { result: "waiting" }, error: null };
    if (name === "wa_health_record") { d.health = args.p_health; return { data: { result: "recorded" }, error: null }; }
    return { data: null, error: null };
  };
  g.__supaResolver = (table: string) => table === "wa_template_setup" ? { data: { health_checked_at: d.healthAt }, error: null } : { data: null, error: null };
  return d;
}
type Route = (url: string, init?: RequestInit) => Response | null;
function meta(list: unknown[], routes: Route[] = []) {
  return installFetch((url, init) => {
    if (!url.startsWith("https://graph.facebook.com/")) throw new Error("unexpected host " + url);
    for (const r of routes) { const x = r(url, init); if (x) return x; }
    if (url.startsWith(G + WABA + "/message_templates?")) return jsonResponse({ data: list });
    if (url.startsWith(G + PHONE + "?")) return jsonResponse({ id: PHONE, quality_rating: "GREEN" });
    throw new Error("unexpected Meta call " + (init?.method || "GET") + " " + url);
  });
}
async function run(d: () => Db, list: unknown[], routes: Route[] = [], body: unknown = {}, secret = SECRET) {
  resetSupaMock(); const state = d();
  const rEnv = setEnv(ENV), rF = meta(list, routes);
  try {
    const req = new Request("https://fn.local/", { method: "POST", headers: { "Content-Type": "application/json", "x-helm-cron-secret": secret }, body: JSON.stringify(body) });
    const { result: res, logs } = await captureConsoleError(async () => await (await loadHandler(FN))(req));
    const text = await res.text();
    return { status: res.status, body: JSON.parse(text), text, logs, calls: fetchLog().slice(), db: state };
  } finally { rF(); rEnv(); }
}
const posts = (calls: { url: string; init?: RequestInit }[]) => calls.filter((c) => c.init?.method === "POST");
function noSecret(r: { text: string; logs: string[]; calls: { url: string; init?: RequestInit }[]; db: Db }) {
  assert(!r.text.includes(TOKEN), "the answer never carries the token");
  assert(!r.logs.join("\n").includes(TOKEN), "the logs never carry the token");
  assert(!JSON.stringify(r.db.recorded).includes(TOKEN), "a stored error never carries the token");
  for (const c of r.calls) { assert(c.url.startsWith("https://graph.facebook.com/")); assert(!c.url.includes(TOKEN)); assertEquals(String((c.init as any)?.headers?.Authorization), "Bearer " + TOKEN); }
}
const lib = (entry: unknown, status = 200): Route => (url) => url.startsWith(G + "message_template_library?") ? jsonResponse(status === 200 ? { data: [entry] } : { error: { code: 100, message: "Unknown path" } }, status) : null;
const create = (fn: (body: any) => [number, unknown]): Route => (url, init) => {
  if (url !== G + WABA + "/message_templates" || init?.method !== "POST") return null;
  const [st, b] = fn(JSON.parse(String(init.body)));
  return jsonResponse(b, st);
};

Deno.test("worker: without the cron secret -> 401, nothing read, Meta never asked", async () => {
  const r = await run(() => db([job("proposal_sent")]), [], [], {}, "wrong");
  assertEquals(r.status, 401);
  assertEquals(r.calls.length, 0);
  assert(!supaLog().some((e) => e.rpc), "no database call");
});

Deno.test("worker: already in the account -> recorded, NOT created again; missing -> Helm wording; refused wording -> failed with Meta code", async () => {
  const r = await run(() => db([job("proposal_sent"), job("staff_shift_result"), job("vendor_request")]),
    [{ name: "proposal_sent", language: "en", status: "APPROVED", category: "UTILITY", id: "9000000001" }],
    [create((b) => b.name === "vendor_request"
      ? [400, { error: { code: 100, error_subcode: 2388293, error_user_title: "Too many variables", error_user_msg: "too many variables for its length - see https://developers.facebook.com/x " + TOKEN } }]
      : [200, { id: "9000000002", status: "PENDING", category: "UTILITY" }])]);
  assertEquals(r.status, 200);
  const ps = posts(r.calls);
  assertEquals(ps.length, 2, "two creates only - proposal_sent exists (idempotent)");
  assert(!ps.some((c) => JSON.parse(String(c.init!.body)).name === "proposal_sent"));
  assertEquals([r.db.recorded.proposal_sent.outcome, r.db.recorded.proposal_sent.meta_status], ["exists", "APPROVED"]);
  assertEquals([r.db.recorded.staff_shift_result.outcome, r.db.recorded.staff_shift_result.variant, r.db.recorded.staff_shift_result.meta_id], ["created", "own", "9000000002"]);
  // the new wording went out (A3)
  assert(/The office has marked your request as \{\{5\}\}/.test(JSON.parse(String(ps.find((c) => JSON.parse(String(c.init!.body)).name === "staff_shift_result")!.init!.body)).components[0].text));
  const f = r.db.recorded.vendor_request;
  assertEquals([f.outcome, f.error.reason, f.error.code, f.error.subcode], ["failed", "ratio", 100, 2388293]);
  assert(!/https?:/.test(f.error.message), "no link kept"); assert(f.error.message.includes("[link]"));
  assert(r.db.synced && Array.isArray(r.db.synced.p_list) && r.db.synced.p_list[0].name === "proposal_sent", "the list was recorded");
  noSecret(r);
});

Deno.test("worker: Template Library entry fits -> created from the library, the blank order stored for the sender", async () => {
  const r = await run(() => db([job("payment_received")]), [],
    [lib({ name: "payment_confirmation_3", category: "UTILITY", body: "Hi {{1}}, we have received your payment of {{2}}. Thank you.", body_param_types: ["TEXT", "AMOUNT"], buttons: [{ type: "URL", text: "View" }] }),
     create((b) => [200, { id: "9000000003", status: "APPROVED", category: "UTILITY", echo: b }])]);
  const ps = posts(r.calls);
  assertEquals(ps.length, 1);
  const b = JSON.parse(String(ps[0].init!.body));
  assertEquals([b.name, b.language, b.category, b.library_template_name], ["payment_received", "en", "UTILITY", "payment_confirmation_3"]);
  assertEquals(b.library_template_button_inputs[0].type, "URL");
  assertEquals(b.library_template_button_inputs[0].url.base_url, "https://www.helm.events/portal.html?token={{1}}");
  assert(!("components" in b), "library version carries no own wording");
  const rec = r.db.recorded.payment_received;
  assertEquals([rec.outcome, rec.variant, rec.library_name], ["created", "library", "payment_confirmation_3"]);
  assertEquals(rec.param_map, { fields: ["name", "amount"], url_button: true });
  assert(r.calls.some((c) => c.url.startsWith(G + "message_template_library?") && c.url.includes("usecase=PAYMENT_CONFIRMATION")));
  noSecret(r);
});

Deno.test("worker: library refuses / nothing fits -> Helm's own wording (fallback)", async () => {
  const r = await run(() => db([job("proposal_approved_pay")]), [],
    [lib({ name: "payment_due_1", category: "UTILITY", body: "Your payment of {{1}} is due on {{2}}.", body_param_types: ["AMOUNT", "DATE"], buttons: [] }),
     create((b) => b.library_template_name ? [400, { error: { code: 100, message: "Invalid parameter" } }] : [200, { id: "9000000004", status: "PENDING" }])]);
  const ps = posts(r.calls);
  assertEquals(ps.length, 2, "library try, then own wording");
  assert(JSON.parse(String(ps[1].init!.body)).components, "second create = Helm's own wording");
  assertEquals([r.db.recorded.proposal_approved_pay.outcome, r.db.recorded.proposal_approved_pay.variant], ["created", "own"]);
  // an entry whose blanks Helm cannot fill is not used at all
  const r2 = await run(() => db([job("payment_received")]), [],
    [lib({ name: "odd_1", category: "UTILITY", body: "Your {{1}} for {{2}} is ready.", body_param_types: ["TEXT", "TEXT"], buttons: [] }),
     create(() => [200, { id: "9000000005", status: "PENDING" }])]);
  assertEquals(posts(r2.calls).length, 1);
  assert(!JSON.parse(String(posts(r2.calls)[0].init!.body)).library_template_name);
});

Deno.test("worker: approval-code template on an unverified business -> failed auth_not_eligible (no retry)", async () => {
  const r = await run(() => db([job("proposal_approval_otp")]), [],
    [lib({}, 400), create(() => [400, { error: { code: 200, message: "This WhatsApp business account does not have permission to create message template." } }])]);
  const rec = r.db.recorded.proposal_approval_otp;
  assertEquals([rec.outcome, rec.error.reason], ["failed", "auth_not_eligible"]);
  const own = JSON.parse(String(posts(r.calls).at(-1)!.init!.body));
  assertEquals([own.category, own.components[2].buttons[0].otp_type], ["AUTHENTICATION", "COPY_CODE"]);
});

Deno.test("worker: Meta rate limit -> the studio pauses, the rest waits without a Meta call", async () => {
  const r = await run(() => db([job("staff_task_changed"), job("staff_leave_result"), job("vendor_follow_up")]), [],
    [create(() => [400, { error: { code: 80008, message: "rate limit" } }])]);
  assertEquals(posts(r.calls).length, 1, "stopped after the first refusal");
  for (const k of ["staff_task_changed", "staff_leave_result", "vendor_follow_up"]) assertEquals(r.db.recorded[k].outcome, "paused", k);
  assertEquals(r.body.paused, 1);
});

Deno.test("worker: Meta temporary failure -> retry (growing wait in the database)", async () => {
  const r = await run(() => db([job("staff_task_changed")]), [], [create(() => [500, { error: { code: 2, message: "Service temporarily unavailable" } }])]);
  assertEquals([r.db.recorded.staff_task_changed.outcome, r.db.recorded.staff_task_changed.error.reason], ["retry", "other"]);
});

Deno.test("worker: Fix and resubmit edits the rejected template in place (POST /<template id>, same name)", async () => {
  const r = await run(() => db([job("vendor_delivery_reminder", { action: "resubmit", meta_id: "9000000777" })]),
    [{ name: "vendor_delivery_reminder", language: "en", status: "REJECTED", rejected_reason: "INVALID_FORMAT", id: "9000000777" }],
    [(url, init) => url === G + "9000000777" && init?.method === "POST" ? jsonResponse({ success: true }) : null]);
  const ps = posts(r.calls);
  assertEquals(ps.length, 1);
  assertEquals(ps[0].url, G + "9000000777");
  assert(/Please deliver on \{\{4\}\} by \{\{5\}\}/.test(JSON.parse(String(ps[0].init!.body)).components[0].text), "the fixed wording");
  assertEquals([r.db.recorded.vendor_delivery_reminder.outcome, r.db.recorded.vendor_delivery_reminder.meta_id], ["created", "9000000777"]);
});

Deno.test("worker: a category change is reported once per template; nightly reads the number health (read-only)", async () => {
  const r = await run(() => db([], { recategorised: [{ name: "helm_notice", from: "UTILITY", to: "MARKETING" }], healthAt: null }), [],
    [(url) => url.startsWith(G + PHONE + "?fields=quality_rating") ? jsonResponse({ id: PHONE, quality_rating: "RED", status: "CONNECTED" }) : null,
     (url) => url.startsWith(G + PHONE + "?fields=messaging_limit_tier") ? jsonResponse({ messaging_limit_tier: "TIER_250" }) : null,
     (url) => url.startsWith(G + PHONE + "?fields=health_status") ? jsonResponse({ health_status: { can_send_message: "BLOCKED", entities: [{ entity_type: "WABA", errors: [{ error_code: 141006, error_description: "No valid payment method", possible_solution: "Add one" }] }] } }) : null],
    { mode: "nightly" });
  assertEquals(r.db.notices, [{ p_org: ORG, p_name: "helm_notice", p_from: "UTILITY", p_to: "MARKETING" }]);
  assertEquals(r.db.health.warnings, ["quality_red", "payment", "limit_low", "blocked"]);
  assertEquals([r.db.health.quality, r.db.health.tier], ["RED", "TIER_250"]);
  assert(r.calls.every((c) => !c.init?.method || c.init.method === "GET"), "health is read-only");
  noSecret(r);
});

Deno.test("worker: a studio whose number is not connected is skipped (no Meta call)", async () => {
  const r = await run(() => db([job("proposal_sent")], { creds: { status: "error", token: TOKEN, phone_number_id: PHONE, waba_id: WABA } }), []);
  assertEquals(r.calls.length, 0);
  assertEquals(r.body.results[0].skipped, "not_connected");
});
