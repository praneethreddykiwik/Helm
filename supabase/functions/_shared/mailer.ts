// Shared outbound e-mail for client-facing mail (client-mailer links, send-otp e-mail code).
//
// Provider order:
//   1. Resend  - RESEND_API_KEY + RESEND_FROM set
//   2. SMTP    - SMTP_HOST + SMTP_USER + SMTP_PASS set (SMTP_PORT default 465, SMTP_FROM default SMTP_USER)
//                (built-in client in ./smtp.ts; implicit TLS on 465 - Supabase blocks 25/587)
//                e.g. Gmail: smtp.gmail.com / 465 / you@gmail.com / an App Password
//   3. neither -> { status: "not_configured" } (nothing sent, never throws)
//   R154g: no fallback sender - RESEND_FROM (Resend) / SMTP_FROM, else SMTP_USER (SMTP) must be an e-mail address,
//   otherwise that provider counts as not set up and the reason (setting names only) is logged.
//   A caller may pass opts.prefer = "smtp" (comms-dispatch, release 1018): SMTP first when it is
//   set up, Resend only when SMTP is not. Callers that pass nothing keep the order above.
//
// Display name: EMAIL_BRAND_MODE (single switch). "helm" (default, any unset/unknown value) ->
// "Helm Events"; "studio" -> "<Studio> via Helm Events" (R107 owner wording). The address is always the
// configured sender (SPF/DKIM pass). Reply-To: what the caller resolved (_shared/reply-to.mjs: studio
// reply-to / business e-mail / owner's e-mail); an address equal to the sender is dropped (R107: a reply
// to Helm's own sending address is lost), so no Reply-To is better than that one.
// Designed HTML (email-layout.mjs layout() with opts.reason) already carries the compliance line,
// so only the text footer is appended to it.
// Logs carry only the provider + status code, never the recipient, body or any code.
// Compliance: every message gets the transactional footer ("You received this because ... ·
// Privacy · Helm Events, <postal address>", reason = msg.txReason, default client_link). A
// non-transactional caller passes its own `footer` (with Unsubscribe) + List-Unsubscribe `headers`.
import { postalAddress, txFooter, withFooter } from "./email-compliance.mjs";
import { smtpReason, smtpSend } from "./smtp.ts";
import { fetchWithTimeout } from "./http.ts";   // R142: Resend call has a deadline (timeout = "could not be reached")
import { errTag } from "./cors.ts";
import { logger } from "./log.ts";
const log = logger("mailer");

export type MailMsg = {
  to: string; subject: string; text: string; html?: string;
  studio?: string | null; replyTo?: string | null;
  txReason?: string; footer?: { text: string; html: string }; headers?: Record<string, string>;
  // optional display name (e.g. the studio's own sender name from the Integrations page, 0150);
  // cleaned like every other name; unset -> EMAIL_BRAND_MODE decides
  fromName?: string | null;
};
export type MailResult = { status: "sent" | "not_configured" | "failed"; provider?: "resend" | "smtp"; reason?: string };
export type SmtpSend = (cfg: SmtpCfg, mail: { from: string; to: string; subject: string; text: string; html?: string; replyTo?: string; headers?: Record<string, string> }) => Promise<void>;
export type SmtpCfg = { host: string; port: number; user: string; pass: string; tls: boolean };

export const EMAIL_RE = /^[^\s@<>"',;:\\]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;

type EnvGet = (k: string) => string | undefined;
const envOf = (): EnvGet => (k) => Deno.env.get(k);

// strip anything that could break a header (CR/LF, quotes, angle brackets)
export function cleanName(s: unknown, max = 60): string {
  return String(s ?? "").replace(/[\r\n\t"<>\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
export const HELM_BRAND = "Helm Events";
export type BrandMode = "helm" | "studio";
export function brandMode(env: EnvGet = envOf()): BrandMode {
  return String(env("EMAIL_BRAND_MODE") || "").trim().toLowerCase() === "studio" ? "studio" : "helm";
}
export function fromName(studio: unknown, mode: BrandMode = "helm"): string {
  if (mode !== "studio") return HELM_BRAND;
  const s = cleanName(studio);
  return s ? s + " via " + HELM_BRAND : HELM_BRAND;
}
// "Name <addr>" from a configured sender (which may already be "X <a@b>")
export function senderAddr(configured: string): string {
  const m = /<([^<>\s]+@[^<>\s]+)>/.exec(configured);
  return (m ? m[1] : configured).trim();
}
export function senderHeader(configured: string, studio: unknown, mode: BrandMode = "helm", own?: unknown): string {
  const name = cleanName(own) || fromName(studio, mode);
  return `"${name}" <${senderAddr(configured)}>`;
}

// R154g: the sender ADDRESS must be configured and valid - there is no built-in fallback sender any more (the old
// "onboarding@resend.dev" default is gone everywhere). A provider whose sender is missing / not an address counts as
// NOT set up (fail closed, nothing is sent) and `note` names the setting to fix (names only, never a value).
export function validSender(configured: unknown): boolean {
  return EMAIL_RE.test(senderAddr(String(configured ?? "")));
}
export function mailConfig(env: EnvGet = envOf(), prefer?: "smtp"): { provider: "resend" | "smtp" | null; smtp?: SmtpCfg; from?: string; note?: string } {
  const key = env("RESEND_API_KEY") || "", rfrom = env("RESEND_FROM") || "";
  const host = env("SMTP_HOST") || "", user = env("SMTP_USER") || "", pass = env("SMTP_PASS") || "";
  const sfrom = env("SMTP_FROM") || user;
  const smtpSet = !!(host && user && pass), smtpOn = smtpSet && validSender(sfrom);
  const resendOn = !!(key && rfrom) && validSender(rfrom);
  const smtpCfg = () => {
    const port = Number(env("SMTP_PORT") || "465") || 465;
    return { provider: "smtp" as const, from: sfrom, smtp: { host, port, user, pass, tls: port === 465 } };
  };
  if (prefer === "smtp" && smtpOn) return smtpCfg();
  if (resendOn) return { provider: "resend", from: rfrom };
  if (smtpOn) return smtpCfg();
  const note = key && !resendOn ? "RESEND_API_KEY is set but RESEND_FROM is missing or not an e-mail address"
    : smtpSet ? "SMTP is set but SMTP_FROM / SMTP_USER is not an e-mail address" : undefined;
  return { provider: null, ...(note ? { note } : {}) };
}

// R154g: a plain-text part from simple HTML (the mails that were HTML-only: billing, security, payment). Keeps link
// targets as "label (url)", turns block ends / <br> into line breaks, decodes the common entities.
export function htmlToText(html: unknown): string {
  let s = String(html ?? "");
  s = s.replace(/<!--[\s\S]*?-->/g, "").replace(/<head\b[\s\S]*?<\/head>/gi, "").replace(/<(script|style|title)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  s = s.replace(/<a\b[^>]*href\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => {
    const l = label.replace(/<[^>]+>/g, "").trim();
    return l && l !== href ? l + " (" + href + ")" : href;
  });
  s = s.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|h[1-6]|li|tr|table|ul|ol)>/gi, "\n").replace(/<li\b[^>]*>/gi, "- ");
  s = s.replace(/<[^>]+>/g, "");
  s = s.replace(/&nbsp;/g, " ").replace(/&middot;/g, "\u00b7").replace(/&times;/g, "\u00d7").replace(/&mdash;/g, "\u2014").replace(/&ndash;/g, "\u2013")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;|&#x27;|&apos;/gi, "'")
    .replace(/&#(\d{1,6});/g, (_m, d: string) => String.fromCodePoint(Math.min(0x10ffff, Number(d))))
    .replace(/&amp;/g, "&");
  return s.split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// default SMTP sender: built-in minimal client (./smtp.ts). denomailer (v1.6.0) was dropped:
// its encoding of non-ASCII bodies/headers and opaque errors broke Gmail sends on Supabase Edge.
const builtinSmtp: SmtpSend = (cfg, mail) => smtpSend(cfg, mail);
// opts.idempotencyKey (R154g): sent to Resend as the Idempotency-Key HTTP header (outbox row id), SMTP ignores it.
export async function sendMail(msg: MailMsg, opts: { env?: EnvGet; smtp?: SmtpSend; prefer?: "smtp"; idempotencyKey?: string } = {}): Promise<MailResult> {
  const to = String(msg.to || "").trim();
  if (!EMAIL_RE.test(to)) return { status: "failed", reason: "no valid e-mail address on file" };
  const cfg = mailConfig(opts.env || envOf(), opts.prefer);
  if (!cfg.provider) {
    if (cfg.note) log.error("not sending: " + cfg.note);   // fixed text, setting names only - fail closed, nothing sent
    return { status: "not_configured", reason: cfg.note || "e-mail sending is not set up yet" };
  }
  const rt = String(msg.replyTo ?? "").trim();
  const replyTo = rt && EMAIL_RE.test(rt) && rt.toLowerCase() !== senderAddr(cfg.from!).toLowerCase() ? rt : undefined;
  const subject = String(msg.subject || "").replace(/[\r\n]+/g, " ").slice(0, 200);
  const envGet = opts.env || envOf();
  const from = senderHeader(cfg.from!, msg.studio, brandMode(envGet), msg.fromName);
  const footer = msg.footer || txFooter(msg.txReason || "client_link", { app: envGet("APP_URL") || envGet("APP_ORIGIN"), address: postalAddress(envGet) });
  // designed layout already has the compliance line in its footer -> text footer only
  const designed = !!msg.html && /You received this because/.test(msg.html);
  const body = withFooter({ text: msg.text, html: msg.html }, designed ? { text: footer.text, html: "" } : footer);
  const headers = msg.headers && Object.keys(msg.headers).length ? msg.headers : undefined;
  if (cfg.provider === "resend") {
    try {
      const env = opts.env || envOf();
      const r = await fetchWithTimeout("https://api.resend.com/emails", { redirect: "error",
        method: "POST",
        headers: { "Authorization": "Bearer " + env("RESEND_API_KEY"), "Content-Type": "application/json",
          ...(opts.idempotencyKey && /^[A-Za-z0-9._:-]{1,200}$/.test(opts.idempotencyKey) ? { "Idempotency-Key": opts.idempotencyKey } : {}) },
        body: JSON.stringify({ from, to: [to], subject, text: body.text, ...(body.html ? { html: body.html } : {}), ...(headers ? { headers } : {}), ...(replyTo ? { reply_to: replyTo } : {}) }),
      });
      await r.text();
      if (!r.ok) { log.error("resend status", r.status); return { status: "failed", provider: "resend", reason: "the e-mail provider refused the message" }; }
      return { status: "sent", provider: "resend" };
    } catch (e) { log.error("resend unreachable", errTag(e)); return { status: "failed", provider: "resend", reason: "the e-mail provider could not be reached" }; }
  }
  try {
    await (opts.smtp || builtinSmtp)(cfg.smtp!, { from, to, subject, text: body.text, html: body.html, replyTo, ...(headers ? { headers } : {}) });
    return { status: "sent", provider: "smtp" };
  } catch (e) {
    // safe diagnostic: stage, reply code, server text (never the password, recipient or body)
    const err = e as { name?: string; stage?: string; code?: number | null; message?: string };
    console.error("mailer: smtp send failed", JSON.stringify({
      name: err?.name || "Error", stage: err?.stage || "unknown", code: err?.code ?? null,
      message: String(err?.message || e).split(cfg.smtp!.pass).join("[redacted]").replace(/[^\s<>@]+@[^\s<>@]+/g, "[address]").slice(0, 300),
      host: cfg.smtp!.host, port: cfg.smtp!.port, tls: cfg.smtp!.tls,
    }));
    return { status: "failed", provider: "smtp", reason: smtpReason(e) };
  }
}
