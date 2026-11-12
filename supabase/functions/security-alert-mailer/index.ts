// security-alert-mailer — e-mails queued security alerts (migration 0054) to studio admins
// and, for HQ-level alerts, to the Helm HQ inbox.
// DORMANT BY DEFAULT: unless HELM_SECURITY_ALERTS_ENABLED === "true" every request is a
// no-op 200. Invoked ONLY by a cron / service caller presenting a shared secret.
//
// Secrets / env:
//   HELM_SECURITY_ALERTS_ENABLED="true"   turn it on (anything else → dormant no-op)
//   HELM_SECURITY_ALERT_SECRET            shared secret; caller sends it in the
//                                         `x-helm-cron-secret` header. Unset → every call 401.
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (injected)
//   RESEND_API_KEY + RESEND_FROM, or SMTP_HOST + SMTP_USER + SMTP_PASS (+ SMTP_PORT, SMTP_FROM) - the shared mailer
//                                         (R154g). Neither (or no valid sender address) → the run stops BEFORE claiming:
//                                         no row is touched (no attempt used up), alerts wait until e-mail is set up.
//   HELM_SECURITY_ALERT_HQ_TO             HQ inbox for HQ-level alerts (comma-separated). Unset / no valid address →
//                                         R154g: nothing is claimed, rows wait (never marked skipped for it)
//   SECURITY_ALERT_BATCH                  rows per run, 1..100 (default 25)
//
// The database decides WHO gets mail (security_alert_outbox_claim; since 0250 every row is
// an HQ row - security notices are for Helm HQ only, never studio members) and already throttles floods
// (one row per alert type per studio per 10 minutes, with a count).
// The e-mail carries the alert name, count and studio name only — no links, tokens,
// file names or reasons. Logs carry only counts, SQLSTATE codes and HTTP status.
// Outbound mail goes only through the shared mailer (fixed provider endpoints; no URL is ever taken from input).
import { createClient } from "npm:@supabase/supabase-js@2.119.0";
import { errTag, escHtml, sentryOnce } from "../_shared/cors.ts";
import { BodyTooLarge, clientIp, checkLimits, readBodyCapped } from "../_shared/limits.ts";
import { postalAddress, txFooter } from "../_shared/email-compliance.mjs";
import { logger } from "../_shared/log.ts";
import { htmlToText, mailConfig, sendMail } from "../_shared/mailer.ts";   // R154g: Resend or SMTP (10 s deadline, R142)
const L = logger("security-alert-mailer");

const enc = new TextEncoder();
const EMAIL = /^[^\s@<>"',;:\\]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
const UUIDISH = /^[0-9a-f-]{36}$/i;
const MAX_TO = 20;

export async function secretMatches(given: string, expected: string): Promise<boolean> {
  if (!expected || !given) return false;
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

type SendResult = "sent" | "skipped" | "failed";

// R154g: through the SHARED mailer (_shared/mailer.ts sendMail: Resend when RESEND_API_KEY + RESEND_FROM are set, else
// SMTP) - before, this called Resend directly and an SMTP-only setup marked every alert "skipped" for good. One message
// per recipient (the shared mailer sends to one address); at least one delivered -> "sent", none delivered and one
// failed -> "failed" (released for retry), no valid address -> "skipped". The "no provider" case never reaches here:
// the run stops before claiming (see the handler). Display name "Helm Security"; plain-text part from the same HTML.
async function sendEmail(to: string[], subject: string, html: string): Promise<SendResult> {
  const list = [...new Set(to.filter((t) => EMAIL.test(t)).map((t) => t.toLowerCase()))].slice(0, MAX_TO);
  if (!list.length) return "skipped";
  const env = (k: string) => Deno.env.get(k);
  const footer = txFooter("security", { noLinks: true, app: env("APP_URL"), address: postalAddress(env) });
  const outs: string[] = [];
  for (const addr of list) {
    const r = await sendMail({ to: addr, subject, html, text: htmlToText(html), fromName: "Helm Security", studio: null, footer }, { env });
    outs.push(r.status);
    if (r.status === "failed") L.error("provider failed", r.provider || "unknown");
  }
  return outs.includes("sent") ? "sent" : outs.includes("failed") || outs.includes("not_configured") ? "failed" : "skipped";
}

export function message(label: string, count: number, studio: string, hq: boolean) {
  const times = count > 1 ? ` (${count} times in about 10 minutes)` : "";
  // r21 (0250): every alert is an HQ copy now; name the studio it happened in
  const where = hq ? (studio || "Helm HQ") : (studio || "your studio");
  return {
    subject: `Helm security alert: ${label}${count > 1 ? " ×" + count : ""}`,
    html: `<p>Security alert for <b>${escHtml(where)}</b>:</p><p><b>${escHtml(label)}</b>${escHtml(times)}.</p>` +
      `<p>Sign in to Helm to review the details${hq ? " (HQ → Activity log → Security)" : " (notification bell)"}. ` +
      `If you don't recognise this, change your password and contact your studio admin.</p>`,
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  const log = logger("security-alert-mailer", req);   // R142: JSON log lines with the request id
  const report = sentryOnce(req);   // R142: one Sentry event per run at most (function name + tag only)
  try {
    if (Deno.env.get("HELM_SECURITY_ALERTS_ENABLED") !== "true") return json({ status: "dormant" });
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
    const wait = await checkLimits([["secalert:ip:" + clientIp(req), 30, 60_000]]);
    if (wait) return new Response(JSON.stringify({ error: "too many requests" }), { status: 429, headers: { "Content-Type": "application/json", "Retry-After": String(wait) } });
    await readBodyCapped(req);   // body unused; drained under the 16 KB cap (413 above it)
    const ok = await secretMatches(req.headers.get("x-helm-cron-secret") || "", Deno.env.get("HELM_SECURITY_ALERT_SECRET") || "");
    if (!ok) return json({ error: "unauthorized" }, 401);

    // R154g: no e-mail provider -> do not claim (a claim uses up one of the 5 attempts; after 5 the database closes the
    // row as failed). Rows stay queued untouched and are sent once e-mail is set up.
    const mc = mailConfig((k: string) => Deno.env.get(k));
    if (!mc.provider) { log.warn("no e-mail provider - nothing claimed", undefined, { why: mc.note ? "sender" : "unset" }); return json({ status: "no_provider" }); }
    // R154g: no HQ inbox configured -> do not claim either (since 0250 every row is an HQ row; claiming would use up an
    // attempt and the row used to be marked "skipped" for good). Rows wait until HELM_SECURITY_ALERT_HQ_TO is set.
    const hqTo = String(Deno.env.get("HELM_SECURITY_ALERT_HQ_TO") || "").split(",").map((s) => s.trim()).filter((s) => EMAIL.test(s));
    if (!hqTo.length) { log.warn("HELM_SECURITY_ALERT_HQ_TO is not set - nothing claimed"); return json({ status: "no_recipient" }); }
    const batch = Math.min(100, Math.max(1, Number(Deno.env.get("SECURITY_ALERT_BATCH")) || 25));
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

    const { data: rows, error } = await admin.rpc("security_alert_outbox_claim", { p_limit: batch });
    if (error) { log.error("claim failed", errTag(error)); report.error(error); return json({ error: "internal error" }, 500); }

    const counts = { sent: 0, skipped: 0, failed: 0, invalid: 0 };
    for (const r of (Array.isArray(rows) ? rows : [])) {
      const id = String(r?.id ?? "");
      if (!UUIDISH.test(id)) { counts.invalid++; continue; }
      const hq = r?.hq === true;
      const to = hq ? hqTo : (Array.isArray(r?.to) ? r.to.map((x: unknown) => String(x)) : []);
      const msg = message(String(r?.label || "Security event"), Math.max(1, Number(r?.count) || 1), String(r?.studio || ""), hq);
      const res = await sendEmail(to, msg.subject, msg.html);
      const { error: mErr } = await admin.rpc("security_alert_outbox_mark", { p_id: id, p_status: res === "failed" ? "retry" : res });
      if (mErr) { log.error("mark failed", errTag(mErr)); report.error(mErr); counts.failed++; continue; }
      counts[res]++;
    }
    log.info("run", counts);
    if (counts.failed > 0) report.fail("send_failed");   // failed sends (retried next run) or rows not marked
    return json({ status: "ok", ...counts });
  } catch (e) {
    if (e instanceof BodyTooLarge) return json({ error: "payload too large" }, 413);
    log.error("security-alert-mailer error", errTag(e));
    report.error(e);
    return json({ error: "internal error" }, 500);
  }
});
