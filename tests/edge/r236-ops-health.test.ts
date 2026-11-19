// R236 (0402) comms-dispatch: never send twice when "mark as sent" fails (JOB-03), the heartbeat for HQ System health
// (JOB-01), and WhatsApp rows of a studio whose token broke wait for the reconnect instead of being skipped (MSG-01).
// Mock-only: fake SMTP behind Deno.connect, mocked Supabase + Meta; no network, no real e-mail or WhatsApp.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { setEnv, installFetch, jsonResponse, loadHandler, resetSupaMock, supaLog, captureConsoleError } from "./harness.ts";

const g = globalThis as any;
const FN = "../../supabase/functions/comms-dispatch/index.ts";
const CRON = "comms-shared-secret-xyz";
const ORG = "a0000000-0000-4000-8000-000000000001";
const S1 = "f2360000-0000-4000-8000-000000000001", C1 = "f2360000-0000-4000-8000-0000000000c1", T1 = "f2360000-0000-4000-8000-0000000000e1";
const QID = "a0000000-0000-4000-8000-00000000da01", TOK = "b0000000-0000-4000-8000-0000000000aa";
const BASE = { SUPABASE_URL: "https://proj.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-secret", HELM_COMMS_SECRET: CRON,
  APP_URL: "https://www.helm.events", COMMS_MARK_RETRY_MS: "0,0,0" };
const SMTP = { SMTP_HOST: "smtp.gmail.com", SMTP_PORT: "465", SMTP_USER: "owner@gmail.com", SMTP_PASS: "gmail-app-pass" };
const STUDIO_TOKEN = "studio-wa-token-0123456789abcdef", STUDIO_PHONE_ID = "1098765432";

// ---- in-memory fake SMTP server (counts delivered messages) ------------------------------------------------------------
function installFakeSmtp(): { sent: string[]; restore: () => void } {
  const sent: string[] = [];
  const orig = (Deno as any).connect, origTls = (Deno as any).connectTls, origStart = (Deno as any).startTls;
  const enc = new TextEncoder(), dec = new TextDecoder();
  const fake = () => {
    let out = "220 fake ready\r\n", inbuf = "", inData = false, rcpt = "";
    const pump = () => {
      for (;;) {
        if (inData) { const end = inbuf.indexOf("\r\n.\r\n"); if (end < 0) return; inbuf = inbuf.slice(end + 5); inData = false; sent.push(rcpt); out += "250 queued\r\n"; continue; }
        const i = inbuf.indexOf("\r\n"); if (i < 0) return;
        const line = inbuf.slice(0, i); inbuf = inbuf.slice(i + 2);
        if (line.startsWith("EHLO")) out += "250-fake\r\n250 AUTH PLAIN\r\n";
        else if (line.startsWith("AUTH")) out += "235 ok\r\n";
        else if (line.startsWith("MAIL FROM:")) out += "250 ok\r\n";
        else if (line.startsWith("RCPT TO:")) { rcpt = line.slice(8); out += "250 ok\r\n"; }
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

const STAFF_ROW = { id: S1, to: "ravi@studio.test", kind: "task_reminder", name: "Ravi Kumar", quote_id: QID, studio: "Sparkle Events", event: "Rao Wedding",
  task: "Stage lights", start: "12:30 PM", day: "01 Dec 2026", minutes: 10, link_path: "work.html?token=" + TOK, identity: {} };

type Db = { markFails?: number; ledger?: { lane: string; id: string }[]; comms?: any[]; taskWa?: any[]; waConnected?: boolean; waStatus?: string | null;
  staff?: any[] };
function wireDb(o: Db) {
  resetSupaMock();
  const st = { marks: [] as { rpc: string; args: any }[], notes: [] as any[], beats: [] as any[], markCalls: 0 };
  let fails = o.markFails ?? 0;
  g.__supaRpc = (name: string, args: any, key: string) => {
    if (name === "staff_email_claim") return { data: o.staff ?? [], error: null };
    if (name === "comms_outbox_claim") return { data: o.comms ?? [], error: null };
    if (name === "task_wa_claim") return { data: o.taskWa ?? [], error: null };
    if (/_mark$/.test(name)) {
      st.markCalls++;
      if (fails > 0) { fails--; return { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } }; }
      st.marks.push({ rpc: name, args }); return { data: null, error: null };
    }
    if (name === "ops_send_ledger_open") return { data: o.ledger ?? [], error: null };
    if (name === "ops_send_ledger_note") { st.notes.push(args); return { data: true, error: null }; }
    if (name === "ops_heartbeat_beat") { st.beats.push({ ...args, key }); return { data: true, error: null }; }
    if (name === "org_whatsapp_creds") return o.waConnected && key === "service-role-secret" && args?.p_org === ORG
      ? { data: { token: STUDIO_TOKEN, phone_number_id: STUDIO_PHONE_ID }, error: null } : { data: null, error: null };
    if (name === "wa_recipient_opted_out") return { data: false, error: null };
    if (name === "mark_org_integration") return { data: null, error: null };
    return { data: [], error: null };
  };
  g.__supaResolver = (table: string) => {
    if (table === "comms_outbox") return { data: { org_id: ORG }, error: null };
    if (table === "org_whatsapp_accounts") return { data: o.waStatus ? { status: o.waStatus } : null, error: null };
    return { data: null, error: null };
  };
  return st;
}
async function run(env: Record<string, string>, headers: Record<string, string> = { "x-helm-cron-secret": CRON }) {
  const r = setEnv({ ...BASE, ...env });
  try {
    const h = await loadHandler(FN);
    const { result, logs } = await captureConsoleError(async () => await h(new Request("https://fn.local/", { method: "POST", headers })));
    return { status: result.status, out: await result.json(), logs };
  } finally { r(); }
}

// ---- JOB-03: no double send ----------------------------------------------------------------------------------------------
Deno.test("R236 JOB-03: a failed 'sent' mark is retried - one e-mail, marked once, no ledger note", async () => {
  const st = wireDb({ staff: [STAFF_ROW], markFails: 1 });
  const smtp = installFakeSmtp();
  try {
    const { out } = await run(SMTP);
    assertEquals(smtp.sent.length, 1, "exactly one e-mail");
    assertEquals(st.markCalls, 2, "first mark failed, second worked");
    assertEquals(st.marks.map((m) => m.args.p_status), ["sent"]);
    assertEquals(st.notes.length, 0);
    assertEquals(out.sent, 1); assertEquals(out.failed, 0);
  } finally { smtp.restore(); }
});

Deno.test("R236 JOB-03: mark keeps failing -> ledger note; next run marks it sent WITHOUT sending again", async () => {
  let st = wireDb({ staff: [STAFF_ROW], markFails: 99 });
  const smtp = installFakeSmtp();
  try {
    const first = await run(SMTP);
    assertEquals(smtp.sent.length, 1, "it went out once");
    assertEquals(st.markCalls, 3, "three tries of the sent mark");
    assertEquals(st.notes, [{ p_lane: "staff_email", p_id: S1, p_ref: null }], "noted: lane + id only");
    assertEquals(first.out.failed, 1, "counted (Sentry once) like before");
    assert(!JSON.stringify(st.notes).includes("ravi@"), "no address in the note");
    // next tick: the lease hands the same row out again; the ledger says it was already sent
    st = wireDb({ staff: [STAFF_ROW], ledger: [{ lane: "staff_email", id: S1 }] });
    const second = await run(SMTP);
    assertEquals(smtp.sent.length, 1, "NOT sent a second time");
    assertEquals(st.marks.map((m) => [m.rpc, m.args.p_id, m.args.p_status]), [["staff_email_mark", S1, "sent"]]);
    assertEquals(second.out.sent, 1);
    assertEquals(second.status, 200);
  } finally { smtp.restore(); }
});

Deno.test("R236 JOB-03: a 'retry' mark is tried once (as before); a ledger entry of another lane does not stop a send", async () => {
  const st = wireDb({ staff: [STAFF_ROW], markFails: 99, ledger: [{ lane: "staff_update", id: S1 }] });
  const smtp = installFakeSmtp();
  try {
    // no e-mail provider configured -> staff lane not claimed at all (R154g); use a broken SMTP instead -> failed -> retry
    (Deno as any).connect = () => Promise.reject(new Error("refused")); (Deno as any).connectTls = () => Promise.reject(new Error("refused"));
    await run(SMTP);
    assertEquals(st.markCalls, 1, "retry mark not repeated");
    assertEquals(st.notes.length, 0, "nothing went out, nothing noted");
  } finally { smtp.restore(); }
  const st2 = wireDb({ staff: [STAFF_ROW], ledger: [{ lane: "staff_update", id: S1 }, { lane: "bad lane!", id: S1 }] });
  const smtp2 = installFakeSmtp();
  try {
    await run(SMTP);
    assertEquals(smtp2.sent.length, 1, "a note for another lane / a bad note is ignored");
    assertEquals(st2.marks[0].args.p_status, "sent");
  } finally { smtp2.restore(); }
});

Deno.test("R236 JOB-03: a database without 0402 (ledger RPC missing) works as before", async () => {
  const st = wireDb({ staff: [STAFF_ROW] });
  const prev = g.__supaRpc;
  g.__supaRpc = (name: string, args: any, key: string) => name === "ops_send_ledger_open" || name === "ops_heartbeat_beat"
    ? { data: null, error: { code: "PGRST202" } } : prev(name, args, key);
  const smtp = installFakeSmtp();
  try {
    const { status, out } = await run(SMTP);
    assertEquals(status, 200); assertEquals(smtp.sent.length, 1); assertEquals(out.sent, 1);
    assertEquals(st.marks.length, 1);
  } finally { smtp.restore(); }
});

Deno.test("R236 helpers: markWaits / markStatus / markWithRetry", async () => {
  const origServe = (Deno as any).serve;
  (Deno as any).serve = () => ({ finished: Promise.resolve(), shutdown() {}, ref() {}, unref() {} });
  let m: any;
  try { m = await import(FN + "?v=" + crypto.randomUUID()); } finally { (Deno as any).serve = origServe; }
  const { markWaits, markStatus, markWithRetry } = m;
  assertEquals(markWaits(undefined), [0, 400, 1500]);
  assertEquals(markWaits("0,0,0"), [0, 0, 0]);
  assertEquals(markWaits("1,2,x"), [0, 400, 1500]);
  assertEquals(markStatus("failed"), "retry"); assertEquals(markStatus("no_provider"), "retry"); assertEquals(markStatus("held"), "retry");
  assertEquals(markStatus("sent"), "sent"); assertEquals(markStatus("skipped"), "skipped");
  let n = 0;
  const err = await markWithRetry(() => { n++; return Promise.resolve({ error: n < 3 ? { code: "x" } : null }); }, true, [0, 0, 0]);
  assertEquals([err, n], [null, 3]);
  n = 0;
  const err2 = await markWithRetry(() => { n++; return Promise.reject(new Error("down")); }, false, [0, 0, 0]);
  assert(err2 instanceof Error); assertEquals(n, 1);
});

// ---- JOB-01: heartbeat -------------------------------------------------------------------------------------------------------
Deno.test("R236 JOB-01: every run writes one heartbeat (ok + counts; no_provider when no e-mail provider)", async () => {
  let st = wireDb({ staff: [STAFF_ROW] });
  const smtp = installFakeSmtp();
  try {
    await run(SMTP);
    assertEquals(st.beats.length, 1);
    assertEquals(st.beats[0].p_name, "comms-dispatch"); assertEquals(st.beats[0].p_status, "ok"); assertEquals(st.beats[0].p_detail.sent, 1);
    assertEquals(st.beats[0].key, "service-role-secret");
    st = wireDb({ staff: [STAFF_ROW] });
    await run({});
    assertEquals(st.beats.map((b) => b.p_status), ["no_provider"]);
  } finally { smtp.restore(); }
});

Deno.test("R236 JOB-01: switched off (HELM_COMMS_ENABLED=false) -> 200 dormant + a 'dormant' heartbeat only for the real caller", async () => {
  let st = wireDb({});
  const a = await run({ HELM_COMMS_ENABLED: "false" });
  assertEquals(a.status, 200); assertEquals(a.out.status, "dormant");
  assertEquals(st.beats.map((b) => b.p_status), ["dormant"]);
  assertEquals(supaLog().filter((x) => x.rpc && x.rpc !== "ops_heartbeat_beat").length, 0, "nothing claimed");
  st = wireDb({});
  const b = await run({ HELM_COMMS_ENABLED: "false" }, { "x-helm-cron-secret": "wrong" });
  assertEquals(b.out.status, "dormant"); assertEquals(st.beats.length, 0, "a stranger cannot write the heartbeat");
  assertEquals(supaLog().length, 0, "no database client at all");
});

Deno.test("R236 JOB-01: claim failure -> 500 + an 'error' heartbeat", async () => {
  const st = wireDb({});
  const prev = g.__supaRpc;
  g.__supaRpc = (name: string, args: any, key: string) => name === "comms_outbox_claim" ? { data: null, error: { code: "57014" } } : prev(name, args, key);
  const r = await run(SMTP);
  assertEquals(r.status, 500); assertEquals(st.beats.map((b) => b.p_status), ["error"]);
});

// ---- MSG-01: WhatsApp held while the studio's token is broken ------------------------------------------------------------
const WA_ROW = { id: C1, purpose: "wa_forward", channel: "whatsapp", to: "919800000002", payload: { text: "New task for you", type: "task" } };
function metaFetch(answer: () => Response) {
  let meta = 0;
  const restore = installFetch((url) => {
    if (url.startsWith("https://graph.facebook.com/")) { meta++; return answer(); }
    throw new Error("unexpected " + url);
  });
  return { calls: () => meta, restore };
}

Deno.test("R236 MSG-01: studio account in 'error' (token broken) -> the WhatsApp row waits (retry), Meta not called", async () => {
  const st = wireDb({ comms: [WA_ROW], waConnected: false, waStatus: "error" });
  const m = metaFetch(() => jsonResponse({ messages: [{ id: "w1" }] }));
  try {
    const { out } = await run({});
    assertEquals(m.calls(), 0);
    assertEquals(st.marks.map((x) => [x.rpc, x.args.p_status]), [["comms_outbox_mark", "retry"]]);
    assertEquals(out.held, 1); assertEquals(out.failed, 0, "not a Sentry-worthy failure");
  } finally { m.restore(); }
});

Deno.test("R236 MSG-01: never connected (no account / pending) -> skipped as before", async () => {
  for (const s of [null, "pending", "disabled"]) {
    const st = wireDb({ comms: [WA_ROW], waConnected: false, waStatus: s });
    const m = metaFetch(() => jsonResponse({ messages: [{ id: "w1" }] }));
    try {
      await run({});
      assertEquals(st.marks.map((x) => x.args.p_status), ["skipped"], String(s));
    } finally { m.restore(); }
  }
});

Deno.test("R236 MSG-01: Meta refuses the token (190) -> held for retry, not skipped; the account is marked error", async () => {
  const st = wireDb({ comms: [WA_ROW], waConnected: true });
  const m = metaFetch(() => jsonResponse({ error: { code: 190, message: "Error validating access token" } }, 401));
  try {
    const { out } = await run({});
    assertEquals(m.calls(), 1);
    assertEquals(st.marks.map((x) => x.args.p_status), ["retry"]);
    assertEquals(out.held, 1);
    assert(supaLog().some((x) => x.rpc === "mark_org_integration" && x.args.p_status === "error"));
  } finally { m.restore(); }
});

Deno.test("R236 MSG-01: task reminder of a studio whose token broke -> retry 'whatsapp_needs_reconnect'; never connected stays not_set_up", async () => {
  const TW = { id: T1, to: "919800000003", org_id: ORG, template: "helm_task_reminder", params: { name: "Ravi" }, link_path: "work.html?token=" + TOK };
  let st = wireDb({ taskWa: [TW], waConnected: false, waStatus: "error" });
  let m = metaFetch(() => jsonResponse({ messages: [{ id: "w1" }] }));
  try {
    await run({});
    assertEquals(st.marks.map((x) => [x.rpc, x.args.p_status, x.args.p_reason]), [["task_wa_mark", "retry", "whatsapp_needs_reconnect"]]);
  } finally { m.restore(); }
  st = wireDb({ taskWa: [TW], waConnected: false, waStatus: null });
  m = metaFetch(() => jsonResponse({ messages: [{ id: "w1" }] }));
  try {
    await run({});
    assertEquals(st.marks.map((x) => [x.args.p_status, x.args.p_reason]), [["not_set_up", "whatsapp_not_connected"]], "never connected: as before");
  } finally { m.restore(); }
});
