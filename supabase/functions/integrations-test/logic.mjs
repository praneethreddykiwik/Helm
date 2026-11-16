// logic.mjs - pure helpers for integrations-test (0150). No Deno, no network: imported by
// index.ts and by test/integrations-setup.test.mjs. Never reads or returns a secret VALUE,
// only whether one is set.

export const EMAIL_RE = /^[^\s@<>"',;:\\]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const PHONE_RE = /^[0-9]{8,15}$/;
const TPL_NAME = /^[a-z0-9_]{1,64}$/;

// Which channels can really send right now. Booleans only.
//   email:    the same rule as the shared mailer (_shared/mailer.ts mailConfig) that client-mailer, send-otp and
//             invite-mailer use - Resend (RESEND_API_KEY + RESEND_FROM) or SMTP (SMTP_HOST + SMTP_USER + SMTP_PASS).
//             R154: SMTP counts too (before, an SMTP-only setup read "Simulated" although those e-mails went out).
//             Neither -> client e-mails are simulated and teammate invites fall back to Supabase Auth mail.
//   whatsapp: WHATSAPP_TOKEN + numeric WHATSAPP_PHONE_ID + an approved general template
//             (COMMS_WHATSAPP_TEMPLATE) or WHATSAPP_ALLOW_TEXT=1
//             R154g: the sender must be a real address (RESEND_FROM / SMTP_FROM, else SMTP_USER) - no fallback sender.
export function emailProvider(env) {
  const g = (k) => String(env(k) || "").trim();
  if (g("RESEND_API_KEY") && senderAddress(g("RESEND_FROM"))) return "resend";
  if (g("SMTP_HOST") && g("SMTP_USER") && g("SMTP_PASS") && senderAddress(g("SMTP_FROM") || g("SMTP_USER"))) return "smtp";
  return "";
}
export function channelStatus(env) {
  const g = (k) => String(env(k) || "").trim();
  const provider = emailProvider(env);
  const email = !!provider;
  const waCreds = !!g("WHATSAPP_TOKEN") && /^[0-9]{5,20}$/.test(g("WHATSAPP_PHONE_ID"));
  const waTpl = TPL_NAME.test(g("COMMS_WHATSAPP_TEMPLATE")) || g("WHATSAPP_ALLOW_TEXT") === "1";
  return {
    email: { live: email, provider, sender: provider === "resend" ? senderAddress(g("RESEND_FROM")) : provider === "smtp" ? senderAddress(g("SMTP_FROM") || g("SMTP_USER")) : "" },
    whatsapp: { live: waCreds && waTpl, credentials: waCreds, template: waTpl, webhook: !!g("WHATSAPP_APP_SECRET") && !!g("WHATSAPP_WEBHOOK_VERIFY_TOKEN") },
  };
}

// R154: why the e-mail test was only simulated (names of settings only, never a value)
export const EMAIL_NOT_SET_REASON = "no e-mail provider is set up yet: RESEND_API_KEY + RESEND_FROM, or SMTP_HOST + SMTP_USER + SMTP_PASS";

// R169: free mailbox providers whose From address can never be SPF/DKIM aligned with helm.events.
const FREE_MAIL_DOMAINS = /@(gmail|googlemail|yahoo|ymail|outlook|hotmail|live|icloud|me|aol|proton(mail)?|protonmail|zoho)\.[a-z.]+$/i;

// R169: a pure, value-free "why isn't my e-mail landing well?" diagnostic for the Integrations page /
// the EMAIL-WORKING.md setup guide. It reads env NAMES only (never a secret value) and returns plain-words
// hints. It sends nothing and makes no network call - purely a dry-run advisory. Levels: "error" (nothing
// will send), "warn" (will send but deliverability/platform risk), "info" (context / next step).
export function emailSetupHints(env) {
  const g = (k) => String(env(k) || "").trim();
  const out = [];
  const provider = emailProvider(env);
  const resendKey = g("RESEND_API_KEY"), resendFrom = g("RESEND_FROM");
  const smtpHost = g("SMTP_HOST"), smtpUser = g("SMTP_USER"), smtpPass = g("SMTP_PASS");
  const smtpFrom = g("SMTP_FROM") || smtpUser;
  const port = g("SMTP_PORT");

  if (!provider) {
    if (resendKey && !senderAddress(resendFrom)) {
      out.push({ level: "error", code: "resend_from_missing", message: "RESEND_API_KEY is set but RESEND_FROM is missing or is not an e-mail address - set RESEND_FROM (e.g. \"Helm <mail@helm.events>\")." });
    } else if (smtpHost && smtpUser && smtpPass && !senderAddress(smtpFrom)) {
      out.push({ level: "error", code: "smtp_from_missing", message: "SMTP_HOST / SMTP_USER / SMTP_PASS are set but SMTP_FROM (or SMTP_USER) is not an e-mail address - set SMTP_FROM to the login or an allowed alias." });
    } else {
      out.push({ level: "error", code: "not_configured", message: EMAIL_NOT_SET_REASON + "." });
    }
    return out;
  }

  if (provider === "smtp") {
    // Supabase Edge blocks outbound 25 and 587; only implicit-TLS 465 connects. The built-in client
    // CAN STARTTLS on 587, but the platform never lets that connection open, so flag it as an error.
    if (port === "587" || port === "25") {
      out.push({ level: "error", code: "smtp_port_blocked", message: "SMTP_PORT is " + port + ", but Supabase Edge Functions block outbound ports 25 and 587 - the connection will time out. Use SMTP_PORT 465 (implicit TLS)." });
    }
    const host = smtpHost.toLowerCase();
    if (/(^|\.)gmail\.com$|(^|\.)googlemail\.com$/.test(host)) {
      if (port && port !== "465") {
        out.push({ level: "warn", code: "gmail_use_465", message: "For smtp.gmail.com on Supabase Edge, use SMTP_PORT 465 with a 16-character App Password." });
      }
      out.push({ level: "info", code: "gmail_testing_only", message: "Gmail SMTP is for testing only: deliverability is limited and a personal Gmail address cannot be SPF/DKIM aligned with your own domain (~500 messages/day on a personal account)." });
    }
    if (FREE_MAIL_DOMAINS.test(smtpFrom)) {
      out.push({ level: "warn", code: "free_from_not_aligned", message: "The SMTP From address is a free mailbox (e.g. gmail.com) - it cannot be DKIM-signed for helm.events, so mail is more likely to land in spam. For production, send from a verified helm.events sender." });
    }
  }

  if (provider === "resend" && FREE_MAIL_DOMAINS.test(resendFrom)) {
    out.push({ level: "warn", code: "free_from_not_aligned", message: "RESEND_FROM is a free-mailbox address - verify your own domain (helm.events) in Resend and send From that domain for SPF/DKIM alignment." });
  }
  return out;
}

// the bare address out of RESEND_FROM / SMTP_FROM ('Helm <hello@helm.events>' or 'hello@helm.events'), or "" when it
// is missing / not an address. R154g: no fallback sender (the old "onboarding@resend.dev" default is gone) - "" means
// e-mail is not set up and nothing is sent.
export function senderAddress(conf) {
  const c = String(conf || "").trim();
  const m = c.match(/<([^>]+)>/);
  const a = (m ? m[1] : c).trim();
  return EMAIL_RE.test(a) ? a : "";
}

// '"<display name>" <address>' - display name from the studio setting, else the studio name. Display only (the
// Integrations page preview masks the address); with no configured sender the address part is empty: "<>".
export function fromHeader(conf, fromName, studio) {
  const name = String(fromName || studio || "Helm").replace(/["<>\r\n]/g, "").trim().slice(0, 60) || "Helm";
  return `"${name}" <${senderAddress(conf)}>`;
}

export function replyToOf(v) {
  const r = String(v || "").trim().toLowerCase();
  return EMAIL_RE.test(r) ? r : "";
}

// "a***@example.com" - what the page shows; the full address is never echoed back
export function maskEmail(e) {
  const s = String(e || "");
  const i = s.indexOf("@");
  if (i < 1) return "";
  return s[0] + "***" + s.slice(i);
}
export function maskPhone(p) {
  const d = String(p || "").replace(/\D/g, "");
  return d.length >= 8 ? "+" + d.slice(0, 2) + "******" + d.slice(-2) : "";
}

export const TEST_TEXT = "This is a test message from Helm. Your studio's WhatsApp messages are set up correctly.";

// Meta message body for the WhatsApp test (template first, session text only when allowed)
export function waTestContent(env, text = TEST_TEXT) {
  const g = (k) => String(env(k) || "").trim();
  const tpl = g("COMMS_WHATSAPP_TEMPLATE");
  if (TPL_NAME.test(tpl)) {
    const lang = /^[a-z]{2}(_[A-Z]{2})?$/.test(g("WHATSAPP_TPL_LANG")) ? g("WHATSAPP_TPL_LANG") : "en";
    return { type: "template", template: { name: tpl, language: { code: lang }, components: [{ type: "body", parameters: [{ type: "text", text }] }] } };
  }
  if (g("WHATSAPP_ALLOW_TEXT") === "1") return { type: "text", text: { preview_url: false, body: text } };
  return null;
}

export function testEmail(studio) {
  const s = String(studio || "your studio").replace(/[\r\n<>]/g, "").slice(0, 80);
  return {
    subject: "Helm test e-mail for " + s,
    text: "This is a test e-mail from Helm for " + s + ".\nIf you can read this, studio e-mails (invites, payment reminders, follow-ups) are set up correctly.\nReplies to this e-mail go to the reply-to address saved on the Integrations page.",
  };
}

// r59 (0300, audit F-1): what integrations_wa_test_target answered -> a refusal for the page, or "" to go on
export function waTargetRefusal(t) {
  if (!t || typeof t !== "object") return "could not check the number - try again";
  if (t.ok === true) return "";
  if (t.reason === "no_number") return "save your studio WhatsApp number first";
  if (t.reason === "not_team_number") return "the test goes only to a team member's own mobile - use the mobile number saved in your (or a teammate's) Helm profile as the studio WhatsApp number";
  return "could not check the number - try again";
}
// the STOP list lives in 0117 (not applied everywhere yet): a missing table is not an error, anything else is
export function optOutTableMissing(e) {
  const c = String((e && e.code) || "");
  return c === "42P01" || c === "PGRST205" || c === "PGRST106";
}
// test WhatsApps per studio per day (WA_TEST_PER_DAY, 1-20, default 5)
export function waTestPerDay(env) {
  const n = Number(String(env("WA_TEST_PER_DAY") || "").trim());
  return Number.isFinite(n) && n >= 1 ? Math.min(20, Math.floor(n)) : 5;
}
