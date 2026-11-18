// R203 (prod 18 Nov 2026): invite-signup answers with a CLEAR code when Supabase Auth is slow (its own e-mail goes out
// before it answers): createUser failing -> 503 create_failed (+ reason timeout when it did not answer), tagged log line
// with no address / token; Auth's invite / magic-link e-mail not confirmed (504 / time-out) -> 504 send_unconfirmed with
// the honest "may still arrive" sentence; account creation never sends an e-mail. Mocked Supabase, no network.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { setEnv, installFetch, loadHandler, post, resetSupaMock, supaLog, captureConsoleError } from "./harness.ts";

const g = globalThis as any;
const FN = "../../supabase/functions/invite-signup/index.ts";
const ENV = { SUPABASE_URL: "https://proj.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-secret" };
const ORG = "a0000000-0000-4000-8000-000000000203", ADMIN = "b0000000-0000-4000-8000-000000000203";
const PW = "Str0ng!Password#1";
const KEY = "cd".repeat(24);
const KEY_HASH = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(KEY)))].map((b) => b.toString(16).padStart(2, "0")).join("");
const EMAIL = "r203.invitee@example.com";
const auth = () => supaLog().filter((l) => l.auth);
const noFetch = () => installFetch(() => { throw new Error("no fetch expected"); });

function db(state: unknown = { valid: true, account: "none", confirmed: false }) {
  const inv = { id: "i203", email: EMAIL, status: "pending", expires_at: new Date(Date.now() + 86400000).toISOString(), org_id: ORG,
    role: "crew", invited_by: ADMIN, mail_key_hash: KEY_HASH };
  g.__supaResolver = (table: string) => table === "invitations" ? { data: inv, error: null }
    : table === "organizations" ? { data: { name: "Helm Studio" }, error: null }
    : table === "profiles" ? { data: { full_name: "Owner" }, error: null } : { data: null, error: null };
  g.__supaRpc = (name: string) => name === "invite_account_state" ? { data: state, error: null } : { data: null, error: null };
}

Deno.test("R203 authUnanswered: time-out / 502-504 / context canceled yes; 500 SMTP error / 422 / null no", async () => {
  const origServe = (Deno as any).serve;
  (Deno as any).serve = () => ({ finished: Promise.resolve(), shutdown() {}, ref() {}, unref() {} });
  let m: any;
  try { m = await import(`${FN}?pure=${crypto.randomUUID()}`); } finally { (Deno as any).serve = origServe; }
  const { authUnanswered, AUTH_CALL_MS } = m;
  assert(authUnanswered({ name: "AuthRetryableFetchError", message: "TimeoutError: signal timed out", status: 0 }));
  assert(authUnanswered({ status: 504, message: "Gateway Timeout" }));
  assert(authUnanswered({ status: 502 }) && authUnanswered({ status: 503 }));
  assert(authUnanswered({ status: 500, message: "context canceled" }));
  assert(!authUnanswered({ status: 500, message: "Error sending invite email" }));
  assert(!authUnanswered({ status: 422, message: "already registered" }));
  assert(!authUnanswered(null));
  assert(AUTH_CALL_MS >= 60_000 && AUTH_CALL_MS < 150_000, "long enough for a slow mail send, inside the platform limit");
});

Deno.test("R203 create: createUser 500 -> 503 create_failed (tagged log, no address / token / password)", async () => {
  resetSupaMock(); db();
  g.__supaAuth = (op: string) => op === "createUser" ? { data: null, error: { status: 500, name: "AuthApiError", message: "Database error creating new user for " + EMAIL } } : { data: {}, error: null };
  const TOK = "d".repeat(48);
  const r = setEnv(ENV); const f = noFetch();
  try {
    const h = await loadHandler(FN);
    const { result: res, logs } = await captureConsoleError(() => Promise.resolve(h(post({ token: TOK, email: EMAIL, password: PW, full_name: "R", k: KEY }))));
    assertEquals(res.status, 503);
    const j = await res.json();
    assertEquals(j.code, "create_failed"); assertEquals(j.reason, undefined);
    assert(/press Create account again/.test(j.error));
    const all = logs.join(" ");
    assert(all.includes("INVSU_CREATE_FAILED"), all);
    assert(!all.includes("@") && !all.includes(TOK) && !all.includes(PW));
    assertEquals(auth().map((a) => a.auth), ["createUser"], "account creation sends no e-mail");
  } finally { f(); r(); }
});

Deno.test("R203 create: createUser did not answer in time -> 503 create_failed reason timeout (sign in with the chosen password)", async () => {
  resetSupaMock(); db();
  g.__supaAuth = (op: string) => op === "createUser" ? { data: null, error: { status: 0, name: "AuthRetryableFetchError", message: "TimeoutError: signal timed out" } } : { data: {}, error: null };
  const TOK = "e".repeat(48);
  const r = setEnv(ENV); const f = noFetch();
  try {
    const h = await loadHandler(FN);
    const { result: res, logs } = await captureConsoleError(() => Promise.resolve(h(post({ token: TOK, email: EMAIL, password: PW, k: KEY }))));
    assertEquals(res.status, 503);
    const j = await res.json();
    assertEquals([j.code, j.reason], ["create_failed", "timeout"]);
    assert(/try signing in/.test(j.error));
    assert(logs.join(" ").includes("INVSU_CREATE_TIMEOUT"));
  } finally { f(); r(); }
});

Deno.test("R203 resend: Auth's e-mail not confirmed (504) -> 504 send_unconfirmed, honest sentence, tagged log", async () => {
  resetSupaMock(); db({ valid: true, account: "needs_password", confirmed: false });
  g.__supaAuth = () => ({ data: null, error: { status: 504, name: "AuthRetryableFetchError", message: "Gateway Timeout" } });
  const TOK = "f".repeat(48);
  const r = setEnv(ENV); const f = noFetch();
  try {
    const h = await loadHandler(FN);
    const { result: res, logs } = await captureConsoleError(() => Promise.resolve(h(post({ token: TOK, resend: true }))));
    assertEquals(res.status, 504);
    const j = await res.json();
    assertEquals(j.code, "send_unconfirmed");
    assert(/may still arrive/.test(j.error) && !/connection/i.test(j.error));
    assert(logs.join(" ").includes("INVSU_MAIL_TIMEOUT"));
  } finally { f(); r(); }
});
