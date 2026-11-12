// render-photo (0095) - dormant 503 without OPENAI_API_KEY, staff JWT required, the DB decides
// (photo_render_begin as the caller), OpenAI edits called with image[] + model, photos stored. Mock-only.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { setEnv, installFetch, jsonResponse, loadHandler, post, resetSupaMock, supaLog, fetchLog } from "./harness.ts";

const g = globalThis as any;
const FN = "../../supabase/functions/render-photo/index.ts";
const Q = "a0000000-0000-4000-8000-00000000da01";
const AUTH = { authorization: "Bearer user-jwt" };
const BASE = { SUPABASE_URL: "https://proj.supabase.co", SUPABASE_ANON_KEY: "anon-key", SUPABASE_SERVICE_ROLE_KEY: "service-role-secret" };
const ON = { ...BASE, OPENAI_API_KEY: "sk-test-not-real" };
const JPG = btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70));
const body = (o: Record<string, unknown> = {}) => ({ quote_id: Q, prompt: "x".repeat(60), n: 1, quality: "high", size: "1536x1024", images: [{ data: JPG }, { data: JPG }, { data: JPG }], ...o });
function allow() {
  g.__supaGetUser = (jwt: string) => jwt === "user-jwt" ? ({ data: { user: { id: "u1" } } }) : ({ data: { user: null } });
  g.__supaRpc = (name: string) => name === "photo_render_begin" ? ({ data: { usage_id: "11111111-1111-4111-8111-111111111111", org_id: "a0000000-0000-4000-8000-000000000001", used: 1, quota: 60 }, error: null }) : ({ data: null, error: null });
  g.__supaResolver = (table: string) => table === "photo_renders" ? ({ data: { id: "22222222-2222-4222-8222-222222222222" }, error: null }) : ({ data: null, error: null });
}

Deno.test("render-photo: no OPENAI_API_KEY -> 503 render_not_configured, nothing called", async () => {
  resetSupaMock(); allow();
  const rEnv = setEnv(BASE);
  const rF = installFetch(() => { throw new Error("no fetch expected"); });
  try {
    const h = await loadHandler(FN);
    const res = await h(post(body(), AUTH));
    assertEquals(res.status, 503);
    assertEquals((await res.json()).error, "render_not_configured");
    assertEquals(supaLog().filter((x) => x.rpc || x.getUser).length, 0);
  } finally { rF(); rEnv(); }
});

Deno.test("render-photo: no JWT / anon key -> 401, OpenAI never called", async () => {
  resetSupaMock(); allow();
  const rEnv = setEnv(ON);
  let fetched = false;
  const rF = installFetch(() => { fetched = true; return jsonResponse({}); });
  try {
    const h = await loadHandler(FN);
    assertEquals((await h(post(body()))).status, 401);
    assertEquals((await h(post(body(), { authorization: "Bearer anon-key" }))).status, 401);
    assert(!fetched);
  } finally { rF(); rEnv(); }
});

Deno.test("render-photo: DB refuses (no area / quota) -> 403 / 429, OpenAI never called", async () => {
  resetSupaMock(); allow();
  const rEnv = setEnv(ON);
  let fetched = false;
  const rF = installFetch(() => { fetched = true; return jsonResponse({}); });
  try {
    const h = await loadHandler(FN);
    g.__supaRpc = () => ({ data: null, error: { code: "42501", message: "not authorized" } });
    assertEquals((await h(post(body(), AUTH))).status, 403);
    g.__supaRpc = () => ({ data: null, error: { code: "P0001", hint: "render_quota", message: "monthly photo render quota reached" } });
    const r = await h(post(body(), AUTH));
    assertEquals(r.status, 429); assertEquals((await r.json()).error, "render_quota");
    assert(!fetched);
  } finally { rF(); rEnv(); }
});

Deno.test("render-photo: bad input -> 400 before the DB", async () => {
  resetSupaMock(); allow();
  const rEnv = setEnv(ON);
  const rF = installFetch(() => { throw new Error("no fetch expected"); });
  try {
    const h = await loadHandler(FN);
    assertEquals((await h(post(body({ n: 9 }), AUTH))).status, 400);
    assertEquals((await h(post(body({ images: [] }), AUTH))).status, 400);
    assertEquals((await h(post(body({ images: [{ data: btoa("GIF89a....") }] }), AUTH))).status, 400);
    assertEquals((await h(post(body({ quote_id: "nope" }), AUTH))).status, 400);
    assertEquals(supaLog().filter((x) => x.rpc).length, 0);
  } finally { rF(); rEnv(); }
});

Deno.test("render-photo: happy path -> OpenAI edits with image[] x3 + gpt-image-2.5-sunburst, photo stored + returned", async () => {
  resetSupaMock(); allow();
  const rEnv = setEnv(ON);
  let form: FormData | null = null, auth = "";
  const rF = installFetch(async (url, init) => {
    assertEquals(url, "https://api.openai.com/v1/images/edits");
    form = init?.body as FormData; auth = String((init?.headers as any)?.Authorization || "");
    return jsonResponse({ data: [{ b64_json: JPG }] });
  });
  try {
    const h = await loadHandler(FN);
    const res = await h(post(body(), AUTH));
    assertEquals(res.status, 200);
    const j = await res.json();
    assertEquals(j.renders.length, 1); assertEquals(j.renders[0].mime, "image/jpeg");
    assertEquals(form!.getAll("image[]").length, 3);
    assertEquals(form!.get("model"), "gpt-image-2.5-sunburst");
    assertEquals(form!.get("quality"), "high");
    assertEquals(form!.get("size"), "1536x1024");
    assertEquals(auth, "Bearer sk-test-not-real");
    const begin = supaLog().find((x) => x.rpc === "photo_render_begin");
    assertEquals(begin.key, "anon-key");   // as the caller, not the service role
    assert(supaLog().some((x) => x.table === "photo_renders" && x.key === "service-role-secret"));
    assert(supaLog().some((x) => x.table === "photo_render_usage"));
    assertEquals(fetchLog().length, 1);
  } finally { rF(); rEnv(); }
});

Deno.test("render-photo: OpenAI error -> 502, usage marked error", async () => {
  resetSupaMock(); allow();
  const rEnv = setEnv(ON);
  const rF = installFetch(() => jsonResponse({ error: { code: "server_error" } }, 500));
  try {
    const h = await loadHandler(FN);
    assertEquals((await h(post(body(), AUTH))).status, 502);
    const u = supaLog().find((x) => x.table === "photo_render_usage");
    assert(u && JSON.stringify(u.calls).includes("error"));
  } finally { rF(); rEnv(); }
});

Deno.test("render-photo: async - 202 with the job at once, OpenAI call finishes in EdgeRuntime.waitUntil", async () => {
  resetSupaMock(); allow();
  const rEnv = setEnv(ON);
  let bg: Promise<unknown> | null = null;
  // deno-lint-ignore no-explicit-any
  (globalThis as any).EdgeRuntime = { waitUntil: (p: Promise<unknown>) => { bg = p; } };
  const rF = installFetch(async () => jsonResponse({ data: [{ b64_json: JPG }] }));
  try {
    const h = await loadHandler(FN);
    const res = await h(post(body(), AUTH));
    assertEquals(res.status, 202);
    const j = await res.json();
    assert(j.job_id); assertEquals(j.status, "pending"); assertEquals(j.renders, undefined);
    assert(bg, "background task registered");
    const out = (await (bg as unknown as Promise<unknown>)) as unknown[];
    assert(Array.isArray(out) && out.length === 1);
    assert(supaLog().some((x) => x.table === "photo_renders" && x.key === "service-role-secret"));
    assert(supaLog().some((x) => x.table === "photo_render_usage" && JSON.stringify(x.calls).includes("ok")));
  } finally {
    // deno-lint-ignore no-explicit-any
    delete (globalThis as any).EdgeRuntime; rF(); rEnv();
  }
});

// R154a: prod renders failed with "openai 401 expired_secret_key" but the builder said "try again".
// The reason kind is now specific, stored in the usage row and logged as one JSON line (status + code, no key).
Deno.test("render-photo: providerKind maps OpenAI account problems to owner-action kinds", async () => {
  // import with Deno.serve stubbed (the module starts a server at load time)
  const origServe = (Deno as any).serve;
  (Deno as any).serve = () => ({ finished: Promise.resolve(), shutdown() {}, ref() {}, unref() {} });
  let providerKind: (s: number, c: string) => string;
  try { ({ providerKind } = await import(FN + "?pk=" + Date.now())); } finally { (Deno as any).serve = origServe; }
  assertEquals(providerKind(401, "expired_secret_key"), "auth");
  assertEquals(providerKind(401, "invalid_api_key"), "auth");
  assertEquals(providerKind(403, "403"), "auth");
  assertEquals(providerKind(429, "insufficient_quota"), "billing");   // not "busy" - retrying will not help
  assertEquals(providerKind(400, "billing_hard_limit_reached"), "billing");
  assertEquals(providerKind(404, "model_not_found"), "model");
  assertEquals(providerKind(400, "moderation_blocked"), "blocked");
  assertEquals(providerKind(429, "rate_limit_exceeded"), "busy");
  assertEquals(providerKind(500, "server_error"), "failed");
});

Deno.test("render-photo: expired key -> render_provider_auth, usage row says auth, JSON log has status + code but never the key", async () => {
  resetSupaMock(); allow();
  const rEnv = setEnv(ON);
  const rF = installFetch(() => jsonResponse({ error: { code: "expired_secret_key", message: "Your key sk-test-not-real has expired" } }, 401));
  const lines: string[] = [];
  const origErr = console.error;
  console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try {
    const h = await loadHandler(FN);
    const res = await h(post(body(), AUTH));
    assertEquals(res.status, 503);
    assertEquals((await res.json()).error, "render_provider_auth");
    const u = supaLog().find((x) => x.table === "photo_render_usage");
    assert(u && JSON.stringify(u.calls).includes("auth: openai 401 expired_secret_key"));
    const line = lines.find((l) => l.includes("openai images error"));
    assert(line, "structured error line written");
    const o = JSON.parse(line!);
    assertEquals(o.fn, "render-photo"); assertEquals(o.code, "expired_secret_key"); assertEquals(o.status, 401); assertEquals(o.reason, "auth");
    assert(!lines.join("\n").includes("sk-test-not-real"), "the key never reaches the logs");
    assert(!lines.join("\n").includes("has expired"), "the provider message never reaches the logs");
  } finally { console.error = origErr; rF(); rEnv(); }
});

Deno.test("render-photo: insufficient_quota (429) -> render_provider_billing, not busy", async () => {
  resetSupaMock(); allow();
  const rEnv = setEnv(ON);
  const rF = installFetch(() => jsonResponse({ error: { code: "insufficient_quota" } }, 429));
  const origErr = console.error; console.error = () => {};
  try {
    const h = await loadHandler(FN);
    const res = await h(post(body(), AUTH));
    assertEquals((await res.json()).error, "render_provider_billing");
  } finally { console.error = origErr; rF(); rEnv(); }
});

Deno.test("render-photo: provider deadline (TimeoutError) -> render_timeout, not a network failure", async () => {
  resetSupaMock(); allow();
  const rEnv = setEnv(ON);
  const rF = installFetch(() => { throw new DOMException("late", "TimeoutError"); });
  const origErr = console.error; console.error = () => {};
  try {
    const h = await loadHandler(FN);
    const res = await h(post(body(), AUTH));
    assertEquals(res.status, 504);
    assertEquals((await res.json()).error, "render_timeout");
  } finally { console.error = origErr; rF(); rEnv(); }
});

Deno.test("render-photo: the OpenAI deadline stays inside the edge wall clock (default 140 s + 5 s < 150 s Free plan)", async () => {
  const src = await Deno.readTextFile(new URL("../../supabase/functions/render-photo/index.ts", import.meta.url));
  assert(/Number\(Deno\.env\.get\("RENDER_TIMEOUT_MS"\)\) \|\| 140_000/.test(src));
  assert(/timeout \+ 5_000\)/.test(src));
  assert(140_000 + 5_000 < 150_000);
});
