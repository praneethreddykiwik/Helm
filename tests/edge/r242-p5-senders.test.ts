// R242 fix plan Phase 5: (1) no double send for the other mailers (0410 ledger lanes): welcome-mailer (send.ts, also used by
// comms-dispatch), invite-mailer, security-alert-mailer, pkg-client-notify and billing-reminder - a "sent" mark that fails is
// retried, then noted in ops_send_ledger (lane + id only), and the next run marks that row sent WITHOUT sending again;
// (2) render-photo: the Helm-wide cap refusals (0411) become plain 503 / 429 answers before OpenAI is called, and every stored
// picture carries the "AI-generated" marker inside the file (LEG-06). Mock-only: mocked Supabase + Resend, no network, no
// real e-mail, no OpenAI call, no render.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { setEnv, installFetch, jsonResponse, loadHandler, post, resetSupaMock, supaLog, fetchLog } from "./harness.ts";
import { markWaits, markWithRetry, ledgerNote, ledgerOpenIds, sendLedger } from "../../supabase/functions/_shared/send-ledger.ts";
import { runWelcomeBatch, SAFE_MARK } from "../../supabase/functions/welcome-mailer/send.ts";

const g = globalThis as any;
// render-photo's exports without starting its server (Deno.serve stubbed while the module loads)
async function renderPhotoModule(): Promise<any> {
  const orig = (Deno as any).serve;
  (Deno as any).serve = () => ({ finished: Promise.resolve(), shutdown() {}, ref() {}, unref() {} });
  try { return await import("../../supabase/functions/render-photo/index.ts?exports=" + crypto.randomUUID()); }
  finally { (Deno as any).serve = orig; }
}
const ID1 = "f2420000-0000-4000-8000-000000000001", ID2 = "f2420000-0000-4000-8000-000000000002";
const ORG = "a0000000-0000-4000-8000-000000000001";
const RESEND = { RESEND_API_KEY: "re_test", RESEND_FROM: "Helm <notifications@helm.events>" };
const resendOk = () => installFetch((url) => { if (url === "https://api.resend.com/emails") return jsonResponse({ id: "re-1" }); throw new Error("unexpected " + url); });
const sends = () => fetchLog().filter((c) => c.url === "https://api.resend.com/emails").length;
const notes = () => supaLog().filter((l) => l.rpc === "ops_send_ledger_note");

// a database: claim answers `rows`; the named mark fails `fails` times; the ledger lists `open` as already sent
function wire(o: { claim: string; rows: any[]; mark: string; fails?: number; open?: { lane: string; id: string }[] }) {
  resetSupaMock();
  let fails = o.fails ?? 0;
  g.__supaRpc = (name: string) => {
    if (name === o.claim) return { data: o.rows, error: null };
    if (name === o.mark) { if (fails > 0) { fails--; return { data: null, error: { code: "57014", message: "timeout" } }; } return { data: "ok", error: null }; }
    if (name === "ops_send_ledger_open") return { data: o.open ?? [], error: null };
    if (name === "ops_send_ledger_note") return { data: true, error: null };
    if (name === "welcome_email_switch") return { data: true, error: null };
    if (name === "wa_recipient_opted_out") return { data: false, error: null };
    return { data: null, error: null };
  };
}

// ---- the shared helper ------------------------------------------------------------------------------------------------
Deno.test("r242 send-ledger: waits parsed, a sent mark is retried (others once), a refused note = false, open ids per lane", async () => {
  assertEquals(markWaits("0,0,0"), [0, 0, 0]); assertEquals(markWaits("bad"), [0, 400, 1500]); assertEquals(markWaits(undefined), [0, 400, 1500]);
  let n = 0;
  const failTwice = () => Promise.resolve({ error: ++n <= 2 ? { code: "57014" } : null });
  assertEquals(await markWithRetry(failTwice, true, [0, 0, 0]), null); assertEquals(n, 3);
  n = 0; assert(await markWithRetry(failTwice, false, [0, 0, 0])); assertEquals(n, 1);
  const refused = { rpc: () => Promise.resolve({ data: false, error: null }) };
  assertEquals(await ledgerNote(refused, "pkg", ID1, null, [0]), false);   // a database without 0410 refuses the lane
  const openDb = { rpc: () => Promise.resolve({ data: [{ lane: "pkg", id: ID1 }, { lane: "invite", id: ID2 }, { lane: "pkg", id: "nope" }], error: null }) };
  assertEquals([...await ledgerOpenIds(openDb, "pkg")], [ID1]);
  const broken = { rpc: () => Promise.reject(new Error("down")) };
  assertEquals((await ledgerOpenIds(broken, "pkg")).size, 0);
  const led = await sendLedger(openDb, "invite", "0");
  assert(led.already(ID2) && !led.already(ID1));
});

// ---- invite-mailer ----------------------------------------------------------------------------------------------------
const INV = "../../supabase/functions/invite-mailer/index.ts";
const INV_ENV = { SUPABASE_URL: "https://proj.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-secret", SUPABASE_ANON_KEY: "anon",
  HELM_INVITE_EMAIL_SECRET: "invite-secret", INVITE_MARK_RETRY_MS: "0,0,0", ...RESEND };
const invRow = { id: ID1, to: "new.person@ia.test", token: "a".repeat(48), inviter: "Priya", studio: "ABCD", role: "supervisor", expires_at: "2026-12-25T00:00:00Z" };
const invReq = () => new Request("https://fn.local/", { method: "POST", headers: { "x-helm-cron-secret": "invite-secret" } });

Deno.test("r242 invite-mailer: sent but every mark failed -> noted (lane invite, id only); next run marks it WITHOUT a second e-mail", async () => {
  const rEnv = setEnv(INV_ENV); const rF = resendOk();
  try {
    wire({ claim: "invite_email_outbox_claim", rows: [invRow], mark: "invite_email_outbox_mark", fails: 3 });
    let h = await loadHandler(INV);
    let j = await (await h(invReq())).json();
    assertEquals(sends(), 1); assertEquals(j.failed, 1);
    assertEquals(notes().length, 1);
    assertEquals(notes()[0].args, { p_lane: "invite", p_id: ID1, p_ref: null });
    assert(!JSON.stringify(notes()).includes("new.person"), "never an address in the note");
    // next run: the lease hands the row out again; the ledger says it went out -> marked sent, nothing sent
    g.__fetchLog = [];
    wire({ claim: "invite_email_outbox_claim", rows: [invRow], mark: "invite_email_outbox_mark", open: [{ lane: "invite", id: ID1 }] });
    h = await loadHandler(INV);
    j = await (await h(invReq())).json();
    assertEquals(sends(), 0); assertEquals(j.sent, 1);
    const m = supaLog().filter((l) => l.rpc === "invite_email_outbox_mark");
    assertEquals(m.length, 1); assertEquals(m[0].args.p_status, "sent");
  } finally { rF(); rEnv(); }
});

Deno.test("r242 invite-mailer: a mark that fails once is retried - one e-mail, no ledger note", async () => {
  const rEnv = setEnv(INV_ENV); const rF = resendOk();
  try {
    wire({ claim: "invite_email_outbox_claim", rows: [invRow], mark: "invite_email_outbox_mark", fails: 1 });
    const h = await loadHandler(INV);
    const j = await (await h(invReq())).json();
    assertEquals(sends(), 1); assertEquals(j.sent, 1); assertEquals(notes().length, 0);
  } finally { rF(); rEnv(); }
});

// ---- security-alert-mailer --------------------------------------------------------------------------------------------
const SEC = "../../supabase/functions/security-alert-mailer/index.ts";
const SEC_ENV = { SUPABASE_URL: "https://proj.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-secret", HELM_SECURITY_ALERTS_ENABLED: "true",
  HELM_SECURITY_ALERT_SECRET: "sec-secret", HELM_SECURITY_ALERT_HQ_TO: "hq@helm.test", SECURITY_ALERT_MARK_RETRY_MS: "0,0,0", ...RESEND };
const secRow = { id: ID2, hq: true, label: "Sign-in locked", count: 2, studio: "ABCD" };
const secReq = () => new Request("https://fn.local/", { method: "POST", headers: { "x-helm-cron-secret": "sec-secret" } });

Deno.test("r242 security-alert-mailer: mark failure noted (lane security); the next run marks without a second alert", async () => {
  const rEnv = setEnv(SEC_ENV); const rF = resendOk();
  try {
    wire({ claim: "security_alert_outbox_claim", rows: [secRow], mark: "security_alert_outbox_mark", fails: 3 });
    let h = await loadHandler(SEC);
    await (await h(secReq())).json();
    assertEquals(sends(), 1); assertEquals(notes().map((x) => x.args.p_lane), ["security"]);
    g.__fetchLog = [];
    wire({ claim: "security_alert_outbox_claim", rows: [secRow], mark: "security_alert_outbox_mark", open: [{ lane: "security", id: ID2 }] });
    h = await loadHandler(SEC);
    const j = await (await h(secReq())).json();
    assertEquals(sends(), 0); assertEquals(j.sent, 1);
  } finally { rF(); rEnv(); }
});

// ---- pkg-client-notify ------------------------------------------------------------------------------------------------
const PKG = "../../supabase/functions/pkg-client-notify/index.ts";
const PKG_ENV = { SUPABASE_URL: "https://proj.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-secret", HELM_PKG_NOTIFY_ENABLED: "true",
  HELM_PKG_NOTIFY_SECRET: "pkg-secret", PKG_MARK_RETRY_MS: "0,0,0", ...RESEND };
const pkgRow = { id: ID1, kind: "pkg_otp", channel: "email", audience: "client", to: "client@ia.test", payload: { otp: "123456", studio: "ABCD" } };
const pkgReq = () => new Request("https://fn.local/", { method: "POST", headers: { "x-helm-cron-secret": "pkg-secret" } });

Deno.test("r242 pkg-client-notify: a code sent but not marked is never sent twice (lane pkg)", async () => {
  const rEnv = setEnv(PKG_ENV); const rF = resendOk();
  try {
    wire({ claim: "pkg_outbox_claim", rows: [pkgRow], mark: "pkg_outbox_mark", fails: 3 });
    let h = await loadHandler(PKG);
    await (await h(pkgReq())).json();
    assertEquals(sends(), 1); assertEquals(notes().map((x) => [x.args.p_lane, x.args.p_id]), [["pkg", ID1]]);
    g.__fetchLog = [];
    wire({ claim: "pkg_outbox_claim", rows: [pkgRow], mark: "pkg_outbox_mark", open: [{ lane: "pkg", id: ID1 }] });
    h = await loadHandler(PKG);
    const j = await (await h(pkgReq())).json();
    assertEquals(sends(), 0); assertEquals(j.sent, 1);
    assertEquals(supaLog().filter((l) => l.rpc === "pkg_outbox_mark").map((l) => l.args.p_status), ["sent"]);
  } finally { rF(); rEnv(); }
});

// ---- billing-reminder -------------------------------------------------------------------------------------------------
const BIL = "../../supabase/functions/billing-reminder/index.ts";
const BIL_ENV = { SUPABASE_URL: "https://proj.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-secret", HELM_BILLING_REMINDERS_ENABLED: "true",
  HELM_BILLING_CRON_SECRET: "bill-secret", BILLING_MARK_RETRY_MS: "0,0,0", ...RESEND };
const bilReq = () => new Request("https://fn.local/", { method: "POST", headers: { "x-helm-cron-secret": "bill-secret" } });
function wireBilling(o: { updateFails?: number; open?: { lane: string; id: string }[] }) {
  resetSupaMock();
  let fails = o.updateFails ?? 0;
  g.__supaRpc = (name: string) => name === "billing_reminder_recheck" ? { data: "send", error: null }
    : name === "ops_send_ledger_open" ? { data: o.open ?? [], error: null }
    : name === "ops_send_ledger_note" ? { data: true, error: null }
    : name === "studio_billing_email" ? { data: "owner@ia.test", error: null }
    : name === "email_is_opted_out" ? { data: false, error: null } : { data: null, error: null };
  g.__supaResolver = (table: string, calls: [string, unknown[]][]) => {
    if (table === "billing_reminders" && calls.some((c) => c[0] === "update")) {
      if (fails > 0) { fails--; return { data: null, error: { code: "57014", message: "timeout" } }; }
      return { data: null, error: null };
    }
    if (table === "billing_reminders") return { data: [{ id: ID1, org_id: ORG, kind: "due_soon", period_end: "2026-12-01" }], error: null };
    if (table === "organizations") return { data: { name: "ABCD", business_email: "owner@ia.test", business_email_verified_at: "2026-01-01" }, error: null };
    return { data: { email: "owner@ia.test", business_email: "owner@ia.test", business_email_verified_at: "2026-01-01" }, error: null };
  };
}
const updates = () => supaLog().filter((l) => l.table === "billing_reminders" && l.calls.some((c: any) => c[0] === "update"));

Deno.test("r242 billing-reminder: the sent update is retried, then noted (lane billing); the next run marks without a second e-mail", async () => {
  const rEnv = setEnv(BIL_ENV); const rF = resendOk();
  try {
    wireBilling({ updateFails: 3 });
    let h = await loadHandler(BIL);
    await (await h(bilReq())).json();
    assertEquals(sends(), 1); assertEquals(updates().length, 3);
    assertEquals(notes().map((x) => x.args.p_lane), ["billing"]);
    g.__fetchLog = [];
    wireBilling({ open: [{ lane: "billing", id: ID1 }] });
    h = await loadHandler(BIL);
    const j = await (await h(bilReq())).json();
    assertEquals(sends(), 0); assertEquals(j.sent, 1); assertEquals(updates().length, 1);
    assertEquals(supaLog().filter((l) => l.rpc === "billing_reminder_recheck").length, 0, "no recheck / lookup for a row already sent");
  } finally { rF(); rEnv(); }
});

// ---- welcome (send.ts: welcome-mailer + comms-dispatch's welcome lane) -------------------------------------------------
Deno.test("r242 welcome send.ts: mark fails -> noted (lane welcome); a row the ledger lists is marked sent without sending", async () => {
  const sent: any[] = [];
  const env = (k: string) => ({ SMTP_HOST: "smtp.gmail.com", SMTP_USER: "owner@gmail.com", SMTP_PASS: "app-pass", WELCOME_MARK_RETRY_MS: "0,0,0" } as any)[k];
  const row = { id: ID1, kind: "studio_owner", to: "owner@ia.test", studio: "ABCD", name: "Asha", trial: false, safe: SAFE_MARK };
  const mk = (o: { fails?: number; open?: any[] }) => {
    let fails = o.fails ?? 0; const log: any[] = [];
    return { log, rpc: (name: string, args: any) => {
      log.push({ name, args });
      if (name === "welcome_email_switch") return Promise.resolve({ data: true, error: null });
      if (name === "welcome_email_outbox_claim") return Promise.resolve({ data: [row], error: null });
      if (name === "ops_send_ledger_open") return Promise.resolve({ data: o.open ?? [], error: null });
      if (name === "ops_send_ledger_note") return Promise.resolve({ data: true, error: null });
      if (name === "welcome_email_outbox_mark" && fails > 0) { fails--; return Promise.resolve({ data: null, error: { code: "57014" } }); }
      return Promise.resolve({ data: "ok", error: null });
    } };
  };
  const a = mk({ fails: 3 });
  const o1 = await runWelcomeBatch(a, 5, { env, smtp: async (_c, m) => { sent.push(m); } });
  assertEquals(sent.length, 1); assertEquals(o1.counts.failed, 1);
  assertEquals(a.log.filter((x) => x.name === "ops_send_ledger_note").map((x) => x.args.p_lane), ["welcome"]);
  const b = mk({ open: [{ lane: "welcome", id: ID1 }] });
  const o2 = await runWelcomeBatch(b, 5, { env, smtp: async () => { throw new Error("must not send again"); } });
  assertEquals(o2.counts.sent, 1);
  assertEquals(b.log.filter((x) => x.name === "welcome_email_outbox_mark").map((x) => x.args.p_status), ["sent"]);
});

// ---- render-photo: Helm-wide cap answers + AI marker ---------------------------------------------------------------------
const RP = "../../supabase/functions/render-photo/index.ts";
const RP_ENV = { SUPABASE_URL: "https://proj.supabase.co", SUPABASE_ANON_KEY: "anon-key", SUPABASE_SERVICE_ROLE_KEY: "service-role-secret", OPENAI_API_KEY: "sk-test-not-real" };
const JPG = btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70));
const rpBody = () => ({ quote_id: "a0000000-0000-4000-8000-00000000da01", prompt: "x".repeat(60), n: 1, quality: "high", size: "1536x1024", images: [{ data: JPG }, { data: JPG }] });

Deno.test("r242 render-photo: Helm-wide limits refuse BEFORE OpenAI with the database's plain message (503 paused, 429 caps)", async () => {
  const rEnv = setEnv(RP_ENV);
  let fetched = false;
  const rF = installFetch(() => { fetched = true; return jsonResponse({}); });
  try {
    const h = await loadHandler(RP);
    for (const [hint, status, msg] of [["render_helm_off", 503, "Photo renders are paused for all studios right now. Please try again later."],
        ["render_helm_cap", 429, "Helm's photo renders are paused for today (the daily limit for all studios is reached). Please try again tomorrow."],
        ["render_day_cap", 429, "Your studio has made its 40 photo renders for today. You can make more tomorrow."]] as const) {
      resetSupaMock();
      g.__supaGetUser = () => ({ data: { user: { id: "u1" } } });
      g.__supaRpc = () => ({ data: null, error: { code: "P0001", hint, message: msg } });
      const r = await h(post(rpBody(), { authorization: "Bearer user-jwt" }));
      assertEquals(r.status, status);
      assertEquals(await r.json(), { error: hint, message: msg });
    }
    assert(!fetched, "OpenAI never called");
  } finally { rF(); rEnv(); }
});

Deno.test("r242 render-photo aiMark: JPEG gets a COM segment right after SOI, PNG a tEXt Comment chunk with a valid CRC, others unchanged", async () => {
  const { aiMark, AI_NOTE } = await renderPhotoModule();
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 1, 2, 3]);
  const mj = aiMark(jpg, "image/jpeg");
  assertEquals([mj[0], mj[1], mj[2], mj[3]], [0xff, 0xd8, 0xff, 0xfe]);
  const len = (mj[4] << 8) | mj[5];
  assertEquals(new TextDecoder().decode(mj.subarray(6, 4 + len)), AI_NOTE);
  assertEquals([...mj.subarray(4 + len)], [...jpg.subarray(2)], "the picture bytes follow unchanged");
  assert(AI_NOTE.startsWith("AI-generated"));
  // a minimal PNG: signature + IHDR chunk (25 bytes) + IEND
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const ihdr = [0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0, 0x90, 0x77, 0x53, 0xde];
  const iend = [0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];
  const png = new Uint8Array([...sig, ...ihdr, ...iend]);
  const mp = aiMark(png, "image/png");
  const dv = new DataView(mp.buffer), clen = dv.getUint32(33);
  assertEquals(new TextDecoder().decode(mp.subarray(37, 41)), "tEXt");
  assertEquals(new TextDecoder().decode(mp.subarray(41, 41 + 8)), "Comment\u0000");
  // CRC over type + data (same table as zlib)
  const crcT = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  let c = 0xffffffff; for (const b of mp.subarray(37, 41 + clen)) c = crcT[(c ^ b) & 0xff] ^ (c >>> 8);
  assertEquals(dv.getUint32(41 + clen), (c ^ 0xffffffff) >>> 0);
  assertEquals([...mp.subarray(45 + clen)], iend);
  const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2]);
  assertEquals([...aiMark(webp, "image/webp")], [...webp]);
});

Deno.test("r242 render-photo: the stored photo carries the AI marker (inline run, mocked OpenAI)", async () => {
  const rEnv = setEnv(RP_ENV);
  resetSupaMock();
  g.__supaGetUser = () => ({ data: { user: { id: "u1" } } });
  g.__supaRpc = (name: string) => name === "photo_render_begin" ? ({ data: { usage_id: "11111111-1111-4111-8111-111111111111", org_id: ORG, used: 1, quota: 60 }, error: null }) : ({ data: null, error: null });
  g.__supaResolver = (table: string) => table === "photo_renders" ? ({ data: { id: "22222222-2222-4222-8222-222222222222" }, error: null }) : ({ data: null, error: null });
  const out = btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9));
  const rF = installFetch((url) => { if (url === "https://api.openai.com/v1/images/edits") return jsonResponse({ data: [{ b64_json: out }] }); throw new Error("unexpected " + url); });
  try {
    const h = await loadHandler(RP);
    const r = await h(post(rpBody(), { authorization: "Bearer user-jwt" }));
    assertEquals(r.status, 200);
    const j = await r.json();
    const back = Uint8Array.from(atob(j.renders[0].data), (ch) => ch.charCodeAt(0));
    assertEquals([back[2], back[3]], [0xff, 0xfe], "the answer is the marked picture");
    const ins = supaLog().find((l) => l.table === "photo_renders" && l.calls.some((c: any) => c[0] === "insert"));
    const row = ins.calls.find((c: any) => c[0] === "insert")[1][0];
    assert(String(row.data).startsWith("\\xffd8fffe"), "stored bytes start with SOI + COM");
    assertEquals(row.bytes, back.length);
  } finally { rF(); rEnv(); }
});
