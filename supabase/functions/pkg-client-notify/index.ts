// pkg-client-notify - delivers the messages queued by migration 0069 (pkg_outbox):
// client e-mail (shared mailer - Resend or SMTP, R154g; R107: Reply-To = the studio's business e-mail, else its owner's - never Helm's sender;
// sender "<Studio> via Helm Events" when EMAIL_BRAND_MODE=studio) / WhatsApp (Meta Cloud API) for an accepted or declined package
// choice and the booklet confirmation code, and staff WhatsApp for "client picked a
// package" / "package payment received". Numbers that replied STOP are skipped (0155: by the
// claim, and once more right before each WhatsApp send).
// DORMANT BY DEFAULT: unless HELM_PKG_NOTIFY_ENABLED === "true" every request is a no-op 200.
// Invoked ONLY by a cron / service caller presenting a shared secret.
//
// Secrets / env:
//   HELM_PKG_NOTIFY_ENABLED="true"    turn it on (anything else -> dormant no-op)
//   HELM_PKG_NOTIFY_SECRET            shared secret in the `x-helm-cron-secret` header; unset -> 401
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (injected)
//   RESEND_API_KEY + RESEND_FROM, or SMTP_HOST + SMTP_USER + SMTP_PASS (+ SMTP_PORT, SMTP_FROM) - the shared mailer
//                                     (R154g). Neither -> e-mail rows are released for a later try ("retry"), never
//                                     marked skipped (WhatsApp rows in the same batch still go out). Note: each claim
//                                     counts one attempt (0342 backoff 1..60 min, 8 tries) - set e-mail up promptly.
//   WHATSAPP_API_VERSION (default v21.0). R129 (0337): WhatsApp rows go out from the row's STUDIO's own connected
//                                     number (helm_notice template Helm creates in the studio's account); a studio
//                                     without one -> skipped. Helm's own number is never used.
//   PKG_NOTIFY_BATCH                  rows per run, 1..100 (default 25)
//
// Idempotent: the database hands each row out once (claim + mark, unique dedupe key) and
// the row id is sent as the provider idempotency key. Logs carry only counts and status
// codes - never an address, a phone number, a name or a code. Outbound HTTP goes only to a
// FIXED set of provider endpoints (shared mailer / wa-sender); no URL is ever taken from the database except the approval path,
// which must match /approve?token=<uuid> and is joined to the fixed site origin.
import { createClient } from "npm:@supabase/supabase-js@2.119.0";
import { errTag, sentryOnce } from "../_shared/cors.ts";
import { BodyTooLarge, clientIp, checkLimits, readBodyCapped } from "../_shared/limits.ts";
import { render } from "./templates.ts";
import { postalAddress, txFooter } from "../_shared/email-compliance.mjs";
import { brandMode, cleanName, HELM_BRAND, htmlToText, sendMail } from "../_shared/mailer.ts";   // R154g: Resend or SMTP
import { orgOfRow, senderCache, waPost, type WaSender } from "../_shared/wa-sender.ts";   // R129 (0337)
import { noticeContent } from "../_shared/wa-studio.mjs";
import { rowReplyTo } from "../_shared/reply-to.mjs";   // R107: Reply-To = business e-mail, else the studio owner's
import { logger } from "../_shared/log.ts";
const L = logger("pkg-client-notify");

const enc = new TextEncoder();
const EMAIL = /^[^\s@<>"',;:\\]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
const PHONE = /^[0-9]{8,15}$/;
const UUIDISH = /^[0-9a-f-]{36}$/i;

export async function secretMatches(given: string, expected: string): Promise<boolean> {
  if (!expected || !given) return false;
  const [a, b] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(given)), crypto.subtle.digest("SHA-256", enc.encode(expected))]);
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

type Res = "sent" | "skipped" | "failed" | "no_provider";

// R107: display name "Helm" as before; EMAIL_BRAND_MODE=studio -> "<Studio> via Helm Events" (address unchanged)
export function pkgFromName(studio: unknown, mode: "helm" | "studio"): string {
  const s = mode === "studio" ? cleanName(studio) : "";
  return s ? s + " via " + HELM_BRAND : "Helm";
}
// R154g: through the SHARED mailer (_shared/mailer.ts sendMail: Resend when RESEND_API_KEY + RESEND_FROM are set, else
// SMTP) - before, this called Resend directly and an SMTP-only setup marked every client e-mail "skipped" for good.
// Display name as before (pkgFromName: "Helm", or "<Studio> via Helm Events" with EMAIL_BRAND_MODE=studio); Resend gets
// the row id as Idempotency-Key ("pkg-<id>"). No provider (or no valid sender) -> "no_provider": released for a later
// try ("retry"), never marked skipped. No valid address / no message -> "skipped" (as before).
async function sendEmail(id: string, to: string, subject: string, html: string, text: string, studio = "", replyTo = ""): Promise<Res> {
  if (!EMAIL.test(to) || !html) return "skipped";
  const env = (k: string) => Deno.env.get(k);
  const r = await sendMail({ to, subject, html, text: text || htmlToText(html), studio: null, fromName: pkgFromName(studio, brandMode(env)),
    replyTo: replyTo && EMAIL.test(replyTo) ? replyTo : null,
    footer: txFooter("package", { app: env("APP_URL"), address: postalAddress(env) }) }, { env, idempotencyKey: "pkg-" + id });
  if (r.status === "sent") return "sent";
  if (r.status === "not_configured") return "no_provider";
  L.error("email failed", r.provider || "unknown");
  return "failed";
}

// R129 (0337): from the row's STUDIO's own connected number (helm_notice template in the studio's account, one body
// parameter = the text). No connected number -> skipped. Helm's own number is never used for a studio's client.
// deno-lint-ignore no-explicit-any
async function sendWhatsApp(to: string, text: string, sender: WaSender | null, admin: any): Promise<Res> {
  if (!sender || !PHONE.test(to) || !text) return "skipped";
  const content = noticeContent("general", text);
  if (!content) return "skipped";
  const r = await waPost(admin, sender, { to, ...content });
  if (r.ok) return "sent";
  return r.kind === "recipient" || r.kind === "token" || r.kind === "permission" ? "skipped" : "failed";
}

// 0155: last STOP check right before a WhatsApp send (the claim already skipped STOP numbers).
// "skipped" = replied STOP, "failed" = could not check (retried later), null = OK to send.
// deno-lint-ignore no-explicit-any
async function waStopped(admin: any, to: string): Promise<Res | null> {
  try {
    const { data, error } = await admin.rpc("wa_recipient_opted_out", { p_phone: to });
    if (error) { L.error("stop check failed", errTag(error)); return "failed"; }
    return data === true ? "skipped" : null;
  } catch (e) { L.error("stop check error", errTag(e)); return "failed"; }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  const log = logger("pkg-client-notify", req);   // R142: JSON log lines with the request id
  const report = sentryOnce(req);   // R142: one Sentry event per run at most (function name + tag only)
  try {
    if (Deno.env.get("HELM_PKG_NOTIFY_ENABLED") !== "true") return json({ status: "dormant" });
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
    const wait = await checkLimits([["pkgnotify:ip:" + clientIp(req), 30, 60_000]]);
    if (wait) return new Response(JSON.stringify({ error: "too many requests" }), { status: 429, headers: { "Content-Type": "application/json", "Retry-After": String(wait) } });
    await readBodyCapped(req);
    const ok = await secretMatches(req.headers.get("x-helm-cron-secret") || "", Deno.env.get("HELM_PKG_NOTIFY_SECRET") || "");
    if (!ok) return json({ error: "unauthorized" }, 401);

    const batch = Math.min(100, Math.max(1, Number(Deno.env.get("PKG_NOTIFY_BATCH")) || 25));
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const { data: rows, error } = await admin.rpc("pkg_outbox_claim", { p_limit: batch });
    if (error) { log.error("claim failed", errTag(error)); report.error(error); return json({ error: "internal error" }, 500); }

    const counts = { sent: 0, skipped: 0, failed: 0, invalid: 0, no_provider: 0 };
    const rtCache = new Map<string, string>();
    const waSenderOf = senderCache(admin);   // R129: one studio-number lookup per studio per run
    for (const r of (Array.isArray(rows) ? rows : [])) {
      const id = String(r?.id ?? "");
      if (!UUIDISH.test(id)) { counts.invalid++; continue; }
      const kind = String(r?.kind ?? ""), channel = String(r?.channel ?? ""), to = String(r?.to ?? "");
      const msg = render(kind, (r?.payload && typeof r.payload === "object") ? r.payload : {});
      let res: Res = "skipped";
      if (msg && channel === "email" && r?.audience === "client") {
        const p = (r?.payload && typeof r.payload === "object") ? r.payload : {};
        const replyTo = await rowReplyTo(admin, "pkg", id, null, { env: (k: string) => Deno.env.get(k), cache: rtCache });
        res = await sendEmail(id, to, msg.subject, msg.html, msg.text, String(p.studio ?? ""), replyTo);
      }
      else if (msg && channel === "whatsapp") res = (await waStopped(admin, to)) ?? await sendWhatsApp(to, msg.text, await waSenderOf(await orgOfRow(admin, "pkg_outbox", id)), admin);
      // failed / no provider -> released for a later try (never "skipped" just because e-mail is not set up)
      const { error: mErr } = await admin.rpc("pkg_outbox_mark", { p_id: id, p_status: res === "failed" || res === "no_provider" ? "retry" : res });
      if (mErr) { log.error("mark failed", errTag(mErr)); report.error(mErr); counts.failed++; continue; }
      counts[res]++;
    }
    log.info("run", counts);
    if (counts.failed > 0) report.fail("send_failed");   // failed sends (retried next run) or rows not marked
    return json({ status: "ok", ...counts });
  } catch (e) {
    if (e instanceof BodyTooLarge) return json({ error: "payload too large" }, 413);
    log.error("pkg-client-notify error", errTag(e));
    report.error(e);
    return json({ error: "internal error" }, 500);
  }
});
