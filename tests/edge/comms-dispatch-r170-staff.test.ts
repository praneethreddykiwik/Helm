// comms-dispatch R170 (0361): tasks given to staff and task reminders are e-mailed over SMTP (staff_email_claim) with the
// staff footer (office alert: the event manager footer), the studio reply-to and the work / Live Status link on APP_URL;
// a bad row is skipped; every row is marked; no address in the logs. Mock-only: no network, no real e-mail.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { setEnv, installFetch, loadHandler, resetSupaMock, captureConsoleError } from "./harness.ts";

const g = globalThis as any;
const FN = "../../supabase/functions/comms-dispatch/index.ts";
const CRON = "comms-shared-secret-xyz";
const S1 = "f0000000-0000-4000-8000-000000000001", S2 = "f0000000-0000-4000-8000-000000000002", S3 = "f0000000-0000-4000-8000-000000000003", S4 = "f0000000-0000-4000-8000-000000000004";
const BASE = { SUPABASE_URL: "https://proj.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-secret", HELM_COMMS_SECRET: CRON, APP_URL: "https://www.helm.events" };
const SMTP = { SMTP_HOST: "smtp.gmail.com", SMTP_PORT: "587", SMTP_USER: "owner@gmail.com", SMTP_PASS: "gmail-app-pass" };

// ---- in-memory fake SMTP server behind Deno.connect --------------------------------------
type Sent = { from: string; rcpt: string; data: string };
function installFakeSmtp(): { sent: Sent[]; connects: { hostname: string; port: number }[]; restore: () => void } {
  const sent: Sent[] = [], connects: { hostname: string; port: number }[] = [];
  const orig = (Deno as any).connect, origTls = (Deno as any).connectTls, origStart = (Deno as any).startTls;
  const enc = new TextEncoder(), dec = new TextDecoder();
  const fake = (o: { hostname: string; port: number }) => {
    connects.push({ hostname: o.hostname, port: o.port });
    let out = "220 fake ready\r\n", inbuf = "", inData = false, cur: Sent = { from: "", rcpt: "", data: "" };
    const pump = () => {
      for (;;) {
        if (inData) {
          const end = inbuf.indexOf("\r\n.\r\n"); if (end < 0) return;
          cur.data = inbuf.slice(0, end); inbuf = inbuf.slice(end + 5); inData = false;
          sent.push(cur); cur = { from: "", rcpt: "", data: "" }; out += "250 queued\r\n"; continue;
        }
        const i = inbuf.indexOf("\r\n"); if (i < 0) return;
        const line = inbuf.slice(0, i); inbuf = inbuf.slice(i + 2);
        if (line.startsWith("EHLO")) out += "250-fake\r\n250-STARTTLS\r\n250 AUTH PLAIN\r\n";   // R32 SRV-1: port 587 upgrades first
        else if (line === "STARTTLS") out += "220 go ahead\r\n";
        else if (line.startsWith("AUTH")) out += "235 ok\r\n";
        else if (line.startsWith("MAIL FROM:")) { cur.from = line.slice(10); out += "250 ok\r\n"; }
        else if (line.startsWith("RCPT TO:")) { cur.rcpt = line.slice(8); out += "250 ok\r\n"; }
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
  (Deno as any).connect = (o: any) => Promise.resolve(fake(o));
  (Deno as any).connectTls = (o: any) => Promise.resolve(fake(o));
  (Deno as any).startTls = (conn: any) => Promise.resolve(conn);   // the in-memory fake is already "secure"
  return { sent, connects, restore: () => { (Deno as any).connect = orig; (Deno as any).connectTls = origTls; (Deno as any).startTls = origStart; } };
}
// decode the base64 text/plain part (+ the raw headers) of a fake-server message
function partsOf(raw: string): { headers: string; text: string; html: string } {
  const [headers] = raw.split("\r\n\r\n");
  const b64s = [...raw.matchAll(/Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)(?:\r\n--|$)/g)].map((m) => m[1].replace(/\r\n/g, ""));
  const d = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s || ""), (c) => c.charCodeAt(0)));
  return { headers, text: d(b64s[0]), html: d(b64s[1] || "") };
}

const QID = "a0000000-0000-4000-8000-00000000da01", TOK = "b0000000-0000-4000-8000-0000000000aa";
const ROWS = [
  { id: S1, to: "ravi@studio.test", kind: "task_assigned", name: "Ravi Kumar", quote_id: QID, studio: "Sparkle Events", event: "Rao Wedding",
    event_date: "01 Dec 2026", venue: "Palace Grounds", tasks: [{ title: "Sound check", category: "Stage", start: "12:00 PM", day: "01 Dec 2026" },
    { title: "Flower arch", category: "Decor" }], link_path: "work.html?token=" + TOK, identity: { from_name: "Sparkle", reply_to: "ops@sparkle.in" } },
  { id: S2, to: "ravi@studio.test", kind: "task_reminder", name: "Ravi Kumar", quote_id: QID, studio: "Sparkle Events", event: "Rao Wedding",
    task: "Stage lights", start: "12:30 PM", day: "01 Dec 2026", minutes: 10, link_path: "work.html?token=" + TOK, identity: {} },
  { id: S3, to: "boss@studio.test", kind: "office_alert", name: "Asha", quote_id: QID, studio: "Sparkle Events", event: "Rao Wedding",
    task: "Stage lights", worker: "Ravi Kumar", start: "12:30 PM", day: "01 Dec 2026", link_path: "ops.html?quote=" + QID, identity: {} },
  { id: S4, to: "x@y.test", kind: "task_assigned", studio: "Sparkle Events", tasks: [], link_path: "https://evil.example/x" },
];
function wireDb() {
  resetSupaMock();
  const marks: Record<string, string> = {};
  g.__supaRpc = (name: string, args: any) => {
    if (name === "staff_email_claim") return { data: ROWS, error: null };
    if (name === "staff_email_mark") { marks[args.p_id] = args.p_status; return { data: null, error: null }; }
    return { data: [], error: null };
  };
  return { marks };
}
const run = async (env: Record<string, string>) => {
  const r = setEnv({ ...BASE, ...env });
  try {
    const h = await loadHandler(FN);
    const { result, logs } = await captureConsoleError(async () => await h(new Request("https://fn.local/", { method: "POST", headers: { "x-helm-cron-secret": CRON } })));
    return { out: await result.json(), logs };
  } finally { r(); }
};

Deno.test("R170 staff e-mails: task list, reminder, office alert over SMTP; links on APP_URL; footers; reply-to; bad row skipped", async () => {
  const { marks } = wireDb();
  const smtp = installFakeSmtp();
  const f = installFetch((url) => { throw new Error("unexpected fetch " + url); });
  try {
    const { out, logs } = await run({ ...SMTP });
    assertEquals(marks[S1], "sent");
    assertEquals(marks[S2], "sent");
    assertEquals(marks[S3], "sent");
    assertEquals(marks[S4], "skipped");
    const toRavi = smtp.sent.filter((s) => s.rcpt === "<ravi@studio.test>"), toBoss = smtp.sent.find((s) => s.rcpt === "<boss@studio.test>");
    assertEquals(toRavi.length, 2);
    const list = partsOf(toRavi[0].data), rem = partsOf(toRavi[1].data), alert = partsOf(toBoss!.data);
    assert(list.text.includes("Sparkle Events has given you work for Rao Wedding on 01 Dec 2026 at Palace Grounds:"), list.text);
    assert(list.text.includes("  - Sound check (Stage) - starts 12:00 PM on 01 Dec 2026"));
    assert(list.text.includes("https://www.helm.events/work.html?token=" + TOK), "work link on APP_URL");
    assert(list.text.includes("You received this because you are on the staff list of this studio"), "staff footer");
    assert(/Reply-To: <ops@sparkle\.in>/.test(list.headers), "studio reply-to");
    assert(rem.text.includes("Stage lights for Rao Wedding is due in 10 min, at 12:30 PM."), rem.text);
    assert(alert.text.includes("Ravi Kumar has not started Stage lights"), alert.text);
    assert(alert.text.includes("https://www.helm.events/ops.html?quote=" + QID));
    assert(alert.text.includes("you are the manager of this event"), "manager footer");
    // R185: the HTML part is the designed layout (logo, studio eyebrow, button), footer once, text footer still in the text part
    assert(list.html.includes("helm-logo-v") && list.html.includes("Sparkle Events via Helm") && list.html.includes("Open my tasks"), "designed html");
    assertEquals((list.html.match(/You received this because/g) || []).length, 1, "compliance line once in the html");
    assert(rem.html.includes(">Due in 10 min</span>"), "reminder countdown chip");
    assert(!logs.join(" ").includes("ravi@studio.test") && !logs.join(" ").includes("boss@studio.test"), "no address in logs");
    assert(out.sent >= 3);
  } finally { f(); smtp.restore(); }
});

Deno.test("R170 staff e-mails: no e-mail provider -> nothing claimed (rows wait)", async () => {
  resetSupaMock();
  let claimed = false;
  g.__supaRpc = (name: string) => { if (name === "staff_email_claim") claimed = true; return { data: [], error: null }; };
  const f = installFetch((url) => { throw new Error("unexpected fetch " + url); });
  try { await run({}); assert(!claimed, "staff_email_claim must not be called without a provider"); }
  finally { f(); }
});
