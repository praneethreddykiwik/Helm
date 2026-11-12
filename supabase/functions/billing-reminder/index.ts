// billing-reminder — sends Helm subscription "due soon" / "past due" e-mails to studios.
// DORMANT BY DEFAULT: unless HELM_BILLING_REMINDERS_ENABLED === "true" every request is a
// no-op 200. Invoked ONLY by a cron / service caller presenting a shared secret.
//
// Secrets / env:
//   HELM_BILLING_REMINDERS_ENABLED="true"   turn it on (anything else → dormant no-op)
//   HELM_BILLING_CRON_SECRET                shared secret; caller sends it in the
//                                           `x-helm-cron-secret` header. Unset → every call 401.
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (injected)
//   RESEND_API_KEY + RESEND_FROM, or SMTP_HOST + SMTP_USER + SMTP_PASS (+ SMTP_PORT, SMTP_FROM) - the shared mailer
//                                           (R154g). Neither (or no valid sender address) → nothing is sent and NO row
//                                           is touched: reminders stay unsent and go out once e-mail is set up.
//   APP_URL                                 link in the e-mail (default https://www.helm.events)
//   BILLING_REMINDER_BATCH                  rows per run, 1..200 (default 50)
//
// ASSUMED SCHEMA (migration 0045, NOT FINAL — read defensively):
//   billing_reminders(id uuid, org_id uuid, kind 'due_soon'|'past_due'
//                     |'trial_7d'|'trial_3d'|'trial_1d'|'trial_ended' (0058; period_end = trial end), period_end date,
//                     sent_at timestamptz null, channel text null)
//   organizations(id, name, business_email)
// A row is "unsent" while sent_at IS NULL. Marking is idempotent: UPDATE … WHERE id = $1
// AND sent_at IS NULL, so two overlapping cron runs can never double-mark; a row whose
// e-mail failed stays unsent and is retried on the next run.
//   channel = 'email'   sent through the provider
//   channel = 'skipped' no valid studio address / not needed any more (not retried). R154g: "no provider" is NOT a
//                       skip any more - the run stops before touching any row (status "no_provider").
//
// R119 (0327): before EVERY send the database re-checks the row (billing_reminder_recheck): a reminder queued more
// than 3 days ago, or one the studio no longer needs (paid since it was queued, the plan moved on, the trial
// converted / ended), is closed there as channel 'skipped' + skip_reason and is never sent late. A database without
// 0327 (or any error) -> nothing is sent, the row stays unsent (fail closed).
//
// Logs carry only counts, SQLSTATE codes and HTTP status — never addresses or names.
// Outbound mail goes only through the shared mailer (fixed provider endpoints; no URL is ever taken from input).
// R142: the provider call has a 10 s deadline (_shared/http.ts via the shared mailer) - a timeout is a failed send, left
// unsent and retried next run. A run with failures (or a crash) sends ONE Sentry event (function name + tag only, only with SENTRY_DSN).
import { createClient } from "npm:@supabase/supabase-js@2.119.0";
import { errTag, escHtml, sentryOnce } from "../_shared/cors.ts";
import { BodyTooLarge, clientIp, checkLimits, readBodyCapped } from "../_shared/limits.ts";
import { isTrialKind, trialMessage } from "./trial-email.ts";
import { studioBillingEmail } from "../_shared/billing-email.ts";
import { listUnsubHeaders, mktFooter, postalAddress, txFooter, unsubLinks } from "../_shared/email-compliance.mjs";
import { logger } from "../_shared/log.ts";
import { htmlToText, mailConfig, sendMail } from "../_shared/mailer.ts";   // R154g: Resend or SMTP, no fallback sender
const L = logger("billing-reminder");

const enc = new TextEncoder();
const EMAIL = /^[^\s@<>"',;:\\]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
const UUIDISH = /^[0-9a-f-]{36}$/i;

// constant-time compare of two secrets of any length (compare their SHA-256 digests)
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

type SendResult = "sent" | "skipped" | "failed" | "no_provider";

// R154g: through the SHARED mailer (_shared/mailer.ts sendMail: Resend when RESEND_API_KEY + RESEND_FROM are set, else
// SMTP) - before, this called Resend directly and an SMTP-only setup marked every reminder "skipped" for good.
//   no provider (or no valid sender address) -> "no_provider": the row is NOT marked, it stays unsent and is sent on a
//   later run once e-mail is set up (the R119 recheck still closes a reminder that has become too old / not needed).
//   no valid studio address -> "skipped" (as before). Provider refusal / timeout -> "failed" (left unsent, retried).
// The display name stays "Helm Billing"; a plain-text part is built from the same HTML (htmlToText).
type Extra = { footer: { text: string; html: string }; headers?: Record<string, string> };
async function sendEmail(to: string, subject: string, html: string, extra?: Extra): Promise<SendResult> {
  if (!EMAIL.test(to)) return "skipped";
  const env = (k: string) => Deno.env.get(k);
  // compliance: subscription notices are transactional (footer only); trial nudges carry
  // Unsubscribe + RFC 8058 headers (extra, built by the caller)
  const r = await sendMail({ to, subject, html, text: htmlToText(html), fromName: "Helm Billing", studio: null,
    footer: extra?.footer || txFooter("billing", { app: env("APP_URL"), address: postalAddress(env) }),
    ...(extra?.headers && Object.keys(extra.headers).length ? { headers: extra.headers } : {}) }, { env });
  if (r.status === "sent") return "sent";
  if (r.status === "not_configured") return "no_provider";
  L.error("provider failed", r.provider || "unknown");
  return "failed";
}

export function message(kind: string, studio: string, periodEnd: string) {
  const app = (Deno.env.get("APP_URL") || "https://www.helm.events").replace(/\/+$/, "");
  if (isTrialKind(kind)) return trialMessage(kind, studio, periodEnd, app);   // 0058: branded trial e-mails
  const date = /^\d{4}-\d{2}-\d{2}/.test(periodEnd) ? periodEnd.slice(0, 10) : "";
  if (kind === "past_due") {
    return {
      subject: "Your Helm subscription payment is past due",
      html: `<p>Hi ${escHtml(studio)},</p><p>Your Helm subscription period${date ? " ended on <b>" + escHtml(date) + "</b>" : " has ended"} and payment has not been received yet. Please renew to keep your studio active.</p><p><a href="${escHtml(app)}/settings.html">Open billing</a></p>`,
    };
  }
  return {
    subject: "Your Helm subscription renews soon",
    html: `<p>Hi ${escHtml(studio)},</p><p>Your Helm subscription period ends${date ? " on <b>" + escHtml(date) + "</b>" : " soon"}. Renew before then to avoid interruption.</p><p><a href="${escHtml(app)}/settings.html">Open billing</a></p>`,
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  const log = logger("billing-reminder", req);   // R142: JSON log lines with the request id
  const report = sentryOnce(req);                // R142: one Sentry event per run at most
  try {
    if (Deno.env.get("HELM_BILLING_REMINDERS_ENABLED") !== "true") return json({ status: "dormant" });
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
    const wait = await checkLimits([["bill:ip:" + clientIp(req), 30, 60_000]]);
    if (wait) return new Response(JSON.stringify({ error: "too many requests" }), { status: 429, headers: { "Content-Type": "application/json", "Retry-After": String(wait) } });
    await readBodyCapped(req);   // body unused; drained under the 16 KB cap (413 above it)
    const ok = await secretMatches(req.headers.get("x-helm-cron-secret") || "", Deno.env.get("HELM_BILLING_CRON_SECRET") || "");
    if (!ok) return json({ error: "unauthorized" }, 401);

    // R154g: no e-mail provider (or no valid sender) -> stop here, before any row is loaded, re-checked or marked:
    // every reminder stays unsent (retryable) - nothing is marked "skipped" just because e-mail is not set up yet.
    const mc = mailConfig((k: string) => Deno.env.get(k));
    if (!mc.provider) { log.warn("no e-mail provider - nothing sent, rows left unsent", undefined, { why: mc.note ? "sender" : "unset" }); return json({ status: "no_provider" }); }
    const batch = Math.min(200, Math.max(1, Number(Deno.env.get("BILLING_REMINDER_BATCH")) || 50));
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

    // r41-sendwin-0290: a reminder queued outside the studio's send window waits until not_before (studio time).
    // Before 0290 is applied the column does not exist (42703): the old query is used, so nothing is ever stuck.
    const due = () => admin.from("billing_reminders").select("id, org_id, kind, period_end").is("sent_at", null);
    let { data: rows, error } = await due().or(`not_before.is.null,not_before.lte."${new Date().toISOString()}"`)
      .order("period_end", { ascending: true }).limit(batch);
    if (error && String((error as { code?: string }).code || "") === "42703") {
      ({ data: rows, error } = await due().order("period_end", { ascending: true }).limit(batch));
    }
    if (error) { log.error("load failed", errTag(error)); report.error(error); return json({ error: "internal error" }, 500); }

    const counts = { sent: 0, skipped: 0, failed: 0, invalid: 0, no_provider: 0 };
    for (const r of (Array.isArray(rows) ? rows : [])) {
      const id = String(r?.id ?? ""), kind = String(r?.kind ?? "");
      if (!UUIDISH.test(id) || !(["due_soon", "past_due"].includes(kind) || isTrialKind(kind))) { counts.invalid++; continue; }
      // R119 (0327): still due? (too old / paid since / plan moved on -> closed by the database, never sent)
      const { data: chk, error: cErr } = await admin.rpc("billing_reminder_recheck", { p_id: id });
      if (cErr) { log.error("recheck failed", errTag(cErr)); counts.failed++; continue; }
      if (chk !== "send") { counts.skipped++; continue; }
      const { data: org, error: oErr } = await admin.from("organizations").select("name").eq("id", r.org_id).maybeSingle();
      if (oErr) { log.error("studio load failed", errTag(oErr)); counts.failed++; continue; }
      const msg = message(kind, String(org?.name || "there"), String(r.period_end ?? ""));
      // r59 (audit E-03): the studio e-mail only once confirmed, else the studio owner's login e-mail
      const billTo = await studioBillingEmail(admin, String(r.org_id));
      if (billTo === null) { log.error("studio e-mail lookup failed"); counts.failed++; continue; }
      const to = billTo;
      let res: SendResult;
      if (isTrialKind(kind)) {
        // Helm's own trial nudge = non-transactional: skip an opted-out address; no token (0165 not
        // applied) -> skipped, never sent without an unsubscribe link
        let extra: Extra | null = null;
        try {
          const [o, t] = await Promise.all([admin.rpc("email_is_opted_out", { p_org: null, p_email: to }), admin.rpc("email_unsub_token", { p_org: null, p_email: to })]);
          const app = String(Deno.env.get("APP_URL") || "");
          const links = !o.error && !t.error && o.data !== true
            ? unsubLinks(String(t.data ?? ""), { app, functionsUrl: String(Deno.env.get("SUPABASE_URL") || "").replace(/\/+$/, "") + "/functions/v1" }) : null;
          if (links) extra = { footer: mktFooter(links.page, { app, address: postalAddress((k: string) => Deno.env.get(k)), sender: "Helm", reason: "you started a free trial of Helm" }),
                               headers: listUnsubHeaders(links.oneClick, Deno.env.get("UNSUB_MAILTO")) };
        } catch (_) { extra = null; }
        res = extra ? await sendEmail(to, msg.subject, msg.html, extra) : "skipped";
      } else res = await sendEmail(to, msg.subject, msg.html);
      if (res === "failed") { counts.failed++; continue; }               // left unsent → retried next run
      if (res === "no_provider") { counts.no_provider++; continue; }     // R154g: left unsent → sent once e-mail is set up
      const { error: uErr } = await admin.from("billing_reminders")
        .update({ sent_at: new Date().toISOString(), channel: res === "sent" ? "email" : "skipped" })
        .eq("id", id).is("sent_at", null);                                  // idempotent mark
      if (uErr) { log.error("mark failed", errTag(uErr)); report.error(uErr); counts.failed++; continue; }
      counts[res]++;
    }
    log.info("run", counts);
    if (counts.failed > 0) report.fail("send_failed");   // failed sends / checks (left unsent, retried next run)
    return json({ status: "ok", ...counts });
  } catch (e) {
    if (e instanceof BodyTooLarge) return json({ error: "payload too large" }, 413);
    log.error("billing-reminder error", errTag(e));
    report.error(e);
    return json({ error: "internal error" }, 500);
  }
});
