// comms-dispatch - delivers the messages queued by migration 0078 (comms_outbox):
//   * pay_reminder  client payment reminders (automatic + "Send reminder now")  e-mail / WhatsApp
//   * follow_up     polite client follow-ups after the booklet / quote was opened e-mail / WhatsApp
//   * trial reminders (0120) the studio's own 8-day free-trial reminders (day 5 / 7 / 8), e-mail only,
//                   claimed from trial_reminders via trial_reminder_email_claim (re-checked there)
//   * post-trial (0184) the deletion warnings 30 / 7 / 1 day before the trial data is deleted + the Day 7 follow-up,
//                   claimed via trial_retention_email_claim (re-checked there; warnings only while the owner switch
//                   helm_trial_retention.delete_enabled is on)
//   * follow-ups (R124, 0333) the studio owner's Day 0 / 2 / 14 e-mails after the trial ended (Day 7 comes through the
//                   0184 claim), designed HTML + plain text, Helm unsubscribe applies, claimed via
//                   trial_followup_email_claim (re-checked there; works with deletion switched off)
//   * wa_forward    WhatsApp copies of a member's bell notifications (+ studio announcements),
//                   each with a short deep link that opens the exact page in Helm.
//   * invite_site   (0195) "Send to client" on the Invitation Studio: the published invitation
//                   website link, e-mail / WhatsApp (invite-site.mjs; host = APP_URL, path from the row)
//   * delivery reminders (0241) the vendor / staff member responsible for a delivery or arrival, at the reminder
//                   times set on the assignment (e.g. 60 / 30 / 0 min before), e-mail only, each with a fresh
//                   one-click status link APP_URL/delivery?t=<token>; claimed via delivery_reminder_claim (re-checked
//                   there: answered / cancelled / switched off / ended trial -> skipped). Free trial: the database
//                   applies the 0212 caps when it queues them.
//   * vendor requests (0256) a vendor asked to take part in an event (+ reminders 24 h / 48 h later while unanswered),
//                   e-mail only, each with a fresh link APP_URL/vendor-request?t=<token> (accept / decline / invoice);
//                   claimed via vendor_request_claim(limit, 'email') (re-checked there; trials / samples never queue)
//   * run-sheet reminders (0269) the owner of a run-sheet line (team member / staff / vendor with an e-mail), at the
//                   line's reminder times (studio default 15 / 0 min before), e-mail only (WhatsApp goes through the 0132
//                   lane above); claimed via runsheet_reminder_claim (re-checked there; trials / samples never queue)
//   * enquiry replies (0269) the instant thank-you to someone who used a studio's public enquiry form (/<studio>/enquiry),
//                   the studio's own words; claimed via enquiry_reply_claim (re-checked there; trials never queue)
//   * Helm notices (0244) a studio's plan request -> sales@helm.events, and "Ask my admin to upgrade" -> the
//                   studio's admins, claimed from helm_notice_outbox (helm-notices.mjs; transactional footer)
//   * booklet_link  (0200) "Send to client" in the Share booklet dialog: the live client booklet
//                   link (booklet-link.mjs; host = APP_URL, path added by the claim - no token in the row)
//   * quote_expiry  (0262) "your quote is valid until dd/mm/yyyy" reminder before the date (quote-expiry.mjs; the
//                   approval link path is added by the claim - no token in the row; re-checked there)
//   * welcome e-mails (0057 + R119 0327) "Welcome to Helm" for a new studio owner (the free-trial version for a trial
//                   studio) and "You've joined <studio>" for a new teammate, designed HTML through the shared mailer
//                   (welcome-mailer/send.ts). R154g: HELM_WELCOME_EMAILS_ENABLED "true" or unset -> lane on, any
//                   other value -> lane off (welcomeLaneOn). Nothing is claimed until the DATABASE switch is on
//                   (helm_welcome_mail_settings.enabled, default off; APPLY-0327-WELCOME-ON.sql); the 0327 claim hands
//                   out only rows queued in the last 48 hours, re-checked (studio / member / ended trial / duplicate).
// FREE TRIAL (0212): the database queues and hands out a free-trial studio's row ONLY for the invitation /
//   booklet link by e-mail of an ACTIVE trial, under caps (30 a day per studio, 5 a day per address); such a
//   row carries payload.trial_email = true. Checked once more here: a trial-marked row that is not exactly that
//   (any WhatsApp row, any other purpose) is marked skipped and never sent (trial-row.mjs).
// AUTO-ON: runs whenever it is called with the shared secret; each channel switches itself on
// when its secrets exist (e-mail: SMTP_HOST + SMTP_USER + SMTP_PASS, or RESEND_API_KEY;
// WhatsApp, R129 / 0337: the row's studio has connected its OWN WhatsApp number on the Integrations page).
// E-MAIL TRANSPORT (release 1018): SMTP first - the same shared mailer (_shared/mailer.ts + smtp.ts)
// as client-mailer / invite-mailer / welcome-mailer, e.g. Gmail smtp.gmail.com:465 + an App Password.
// Resend only when SMTP is NOT set and RESEND_API_KEY + RESEND_FROM are. Neither -> e-mail rows are "skipped".
// Both transports get the identical body + compliance footer + List-Unsubscribe headers (0165).
// Kill switch: HELM_COMMS_ENABLED="false" -> every request is a no-op 200 and nothing is
// claimed (rows stay queued). Invoked ONLY by a cron / service caller presenting a
// shared secret. The database decides WHAT is due (comms_tick, pg_cron) and re-checks every row
// at claim time (paid / approved / member opt-in withdrawn -> skipped). WhatsApp STOP replies
// (whatsapp_opt_outs, recorded by wa-webhook) are skipped by the claim since 0155, and checked
// once more right before each WhatsApp send (wa_recipient_opted_out; a failed check -> retry later).
//
// Secrets / env:
//   HELM_COMMS_ENABLED="false"        kill switch (unset / anything else -> on)
//   HELM_COMMS_SECRET                 shared secret in the `x-helm-cron-secret` header; unset -> 401
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (injected)
//   SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_PORT (default 465), SMTP_FROM (default SMTP_USER)
//                                     preferred e-mail transport (shared mailer). Display name:
//                                     EMAIL_BRAND_MODE "helm" (default) -> "Helm Events"; "studio" ->
//                                     the studio's sender name (0150) or "<Studio> via Helm Events".
//   RESEND_API_KEY, RESEND_FROM       fallback transport, used only when SMTP is not set; same display-name rule
//                                     (EMAIL_BRAND_MODE) as SMTP - R154g. No fallback sender: RESEND_FROM must be set.
//   Neither set -> e-mail rows are marked "skipped". Reply-To = the studio's reply-to (0150), else (R107) the
//                                     studio's business e-mail, else the studio owner's e-mail - never Helm's
//                                     own sending address (a client reply there is lost); both transports.
//   WHATSAPP_API_VERSION (default v21.0). R129 (0337): WhatsApp rows go out from the row's STUDIO's own connected
//                                     number with the templates Helm creates in the studio's account (helm_task_assigned,
//                                     helm_event_reminder, helm_notice; ONE body parameter {{1}} = the text, language en).
//                                     A studio without a connected number -> skipped. Helm's own number is never used.
//   APP_URL                           site origin for deep links (default https://www.helm.events)
//   COMMS_BATCH                       rows per run, 1..100 (default 25)
//
// Idempotent: the database hands each row out once (claim + mark, UNIQUE dedupe key) and the
// row id is sent as the e-mail provider idempotency key. Logs carry only counts and status
// codes - never an address, a phone number, a name or message text. Outbound HTTP goes only
// to FIXED provider endpoints (shared mailer, wa-sender); no URL is ever taken from the database (deep links are built
// from ids by the same rule as the in-app bell and joined to APP_URL).
// R142: every provider call has a 10 s deadline (_shared/http.ts; SMTP connect too) - a timeout is a failed send, so the
// row goes back to "retry" exactly like a provider refusal. A run with failed rows (or a crash) sends ONE Sentry event
// (function name + tag only, only with SENTRY_DSN). Logs are JSON lines with the request id (_shared/log.ts).
import { createClient } from "npm:@supabase/supabase-js@2.119.0";
import { errTag, escHtml, sentryOnce } from "../_shared/cors.ts";
import { BodyTooLarge, clientIp, checkLimits, readBodyCapped } from "../_shared/limits.ts";
import { absoluteLink } from "./deeplink.js";
import { FOLLOWUP_KINDS, FOLLOWUP_REASON, FOLLOWUP_REPLY_TO, placeFooter, trialReminderEmail, trialRetentionEmail, RETENTION_NOTICE_KINDS, RETENTION_TX_REASON } from "./trial-reminders.mjs";
import { inviteSiteMessage } from "./invite-site.mjs";
import { trialRowAllowed } from "./trial-row.mjs";   // 0212: free trial = link e-mails only
import { bookletMessage } from "./booklet-link.mjs";
import { quoteExpiryMessage } from "./quote-expiry.mjs";
import { deliveryMessage } from "./delivery-reminder.mjs";   // 0241: delivery / arrival reminders
import { vendorRequestMessage, VENDOR_TX_REASON } from "./vendor-request.mjs";   // 0256: vendor requests + reminders
import { helmNoticeEmail, NOTICE_TX_REASON } from "./helm-notices.mjs";   // 0244: sales requests + "ask my admin"
import { runsheetReminderMessage, enquiryReplyMessage, RUNSHEET_TX_REASON, ENQUIRY_TX_REASON } from "./r24-automation.mjs";   // 0269: run-sheet reminders + enquiry replies
import { replyToOf } from "../integrations-test/logic.mjs";
import { listUnsubHeaders, mktFooter, postalAddress, txFooter, unsubLinks } from "../_shared/email-compliance.mjs";
import { brandMode, mailConfig, sendMail, type SmtpSend } from "../_shared/mailer.ts";
import { rowReplyTo } from "../_shared/reply-to.mjs";   // R107: Reply-To fallback (business e-mail -> owner)
import { runWelcomeBatch } from "../welcome-mailer/send.ts";   // R119 (0327): welcome e-mails (database switch, 48 h)
import { orgOfRow, senderCache, waPost, type WaSender } from "../_shared/wa-sender.ts";   // R129 (0337): the studio's own number
import { fieldContent, noticeContent } from "../_shared/wa-studio.mjs";
import { logger } from "../_shared/log.ts";
const L = logger("comms-dispatch");

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

type Res = "sent" | "skipped" | "failed";

function appOrigin(): string {
  const v = (Deno.env.get("APP_URL") || "https://www.helm.events").trim();
  return /^https:\/\/[A-Za-z0-9.-]{1,190}(:[0-9]{1,5})?\/?$/.test(v) ? v.replace(/\/+$/, "") : "https://www.helm.events";
}

// 0150: the studio's own sender name / reply-to (Integrations page), when set
export type Identity = { from_name?: string | null; reply_to?: string | null };
// Compliance (docs/ops/EMAIL-COMPLIANCE.md): every e-mail carries a footer; non-transactional
// mail (follow-ups, trial nudges) also carries a visible Unsubscribe link + RFC 8058 headers.
export type Extra = { footer: { text: string; html: string }; headers?: Record<string, string> };
// which e-mail transport this run uses: SMTP when its three secrets are set (and a valid sender), else Resend when
// RESEND_API_KEY + RESEND_FROM are set, else none (rows skipped). R154g: the shared mailer's own rule (mailConfig).
export function emailTransport(e: (k: string) => string | undefined = (k) => Deno.env.get(k)): "smtp" | "resend" | null {
  return mailConfig(e, "smtp").provider;
}
// Every e-mail goes through the shared mailer (SMTP first, else Resend - R154g: the Resend lane used to build its own
// request, ignored EMAIL_BRAND_MODE and fell back to "onboarding@resend.dev"; now both transports are identical).
// `extra.footer` is the footer (transactional or marketing with Unsubscribe); `extra.headers` the RFC 8058
// List-Unsubscribe headers - passed through as is. Display name (EMAIL_BRAND_MODE, both transports): "helm" (default)
// -> "Helm Events"; "studio" -> the studio's sender name (0150) or "<Studio> via Helm Events". Helm's own mails (trial /
// retention, studio "Helm") always go out as "Helm Events". opts.idempotencyKey -> Resend Idempotency-Key ("comms-<id>").
export async function sendEmailSmtp(to: string, subject: string, text: string, studio: string, ident: Identity, extra: Extra,
  opts: { env?: (k: string) => string | undefined; smtp?: SmtpSend; html?: string; idempotencyKey?: string } = {}): Promise<Res> {
  const e = opts.env || ((k: string) => Deno.env.get(k));
  const own = studio === "Helm";
  const fromName = !own && brandMode(e) === "studio" ? (String(ident.from_name ?? "").trim() || null) : null;
  const r = await sendMail({ to, subject: subject.slice(0, 150), text, html: opts.html || `<p>${escHtml(text).replace(/\n/g, "<br>")}</p>`,
    studio: own ? null : studio, fromName, replyTo: replyToOf(ident.reply_to) || null, footer: extra.footer,
    ...(extra.headers && Object.keys(extra.headers).length ? { headers: extra.headers } : {}) },
    { env: e, prefer: "smtp", ...(opts.smtp ? { smtp: opts.smtp } : {}), ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}) });
  if (r.status === "sent") return "sent";
  if (r.status === "not_configured") return "skipped";
  L.error("email failed", r.provider || "unknown");
  return "failed";
}
// html (R124): a designed message with its footer already placed (placeFooter); default = the plain text in a <p>
async function sendEmail(id: string, to: string, subject: string, text: string, studio: string, ident: Identity = {}, extra?: Extra, html?: string): Promise<Res> {
  if (!EMAIL.test(to) || !text || !extra) return "skipped";
  return await sendEmailSmtp(to, subject, text, studio, ident, extra, { html, idempotencyKey: "comms-" + id });
}

// purposes that are NOT transactional (need consent + unsubscribe); pay_reminder is transactional
export const NON_TRANSACTIONAL = new Set(["follow_up"]);
const env = (k: string) => Deno.env.get(k);
// footer + headers for a non-transactional e-mail, or null (= do not send: opted out, or no token
// because 0165 is not applied yet - fail closed, never send marketing mail without an unsubscribe)
export function marketingExtra(u: any, sender: string, reason: string, app: string, e: (k: string) => string | undefined = env): Extra | null {
  if (!u || u.ok !== true || u.opted_out === true) return null;
  const links = unsubLinks(String(u.token ?? ""), { app, functionsUrl: String(e("SUPABASE_URL") || "").replace(/\/+$/, "") + "/functions/v1" });
  if (!links) return null;
  return { footer: mktFooter(links.page, { app, address: postalAddress(e), sender, reason }),
           headers: listUnsubHeaders(links.oneClick, e("UNSUB_MAILTO")) };
}

// R154g: the welcome lane follows welcome-mailer's switch HELM_WELCOME_EMAILS_ENABLED without silently turning a live
// feature off: exactly "true" -> on; UNSET (or blank) -> on, decided by the DATABASE switch alone
// (helm_welcome_mail_settings.enabled, 0327 - that is how production runs today); any other value ("false", "off",
// "0", "TRUE" ...) -> off, nothing claimed. In every "on" case the 0327 claim still answers only while the database
// switch is on (runWelcomeBatch -> welcome_email_switch), so the database stays the final word.
export function welcomeLaneOn(v: string | undefined): boolean {
  const s = String(v ?? "").trim();
  return s === "" || s === "true";
}

// kill switch only: anything but an explicit "false" keeps the dispatcher on
export function commsOn(v: string | undefined): boolean {
  return String(v ?? "").trim().toLowerCase() !== "false";
}

export type WaKind = "task_assigned" | "event_reminder" | "general";
const TPL_ENV: Record<WaKind, string> = {
  task_assigned: "WHATSAPP_TPL_TASK_ASSIGNED", event_reminder: "WHATSAPP_TPL_EVENT_REMINDER", general: "COMMS_WHATSAPP_TEMPLATE",
};
const TPL_NAME = /^[a-z0-9_]{1,64}$/;
// the approved template for this kind (falls back to the general one), or "" for none
export function templateFor(kind: WaKind, env: (k: string) => string | undefined): string {
  const own = String(env(TPL_ENV[kind]) || "").trim();
  if (TPL_NAME.test(own)) return own;
  const gen = String(env(TPL_ENV.general) || "").trim();
  return TPL_NAME.test(gen) ? gen : "";
}
// Meta's template text parameter may not contain newlines / tabs / 4+ spaces in a row
export function tplParam(text: string): string {
  return String(text || "").replace(/[\r\n\t]+/g, " ").replace(/ {4,}/g, "   ").trim().slice(0, 1000);
}
export function waContent(kind: WaKind, text: string, env: (k: string) => string | undefined): Record<string, unknown> | null {
  const tpl = templateFor(kind, env);
  if (tpl) {
    const lang = /^[a-z]{2}(_[A-Z]{2})?$/.test(String(env("WHATSAPP_TPL_LANG") || "")) ? String(env("WHATSAPP_TPL_LANG")) : "en";
    return { type: "template", template: { name: tpl, language: { code: lang }, components: [{ type: "body", parameters: [{ type: "text", text: tplParam(text) }] }] } };
  }
  if (env("WHATSAPP_ALLOW_TEXT") === "1") return { type: "text", text: { preview_url: false, body: text.slice(0, 1000) } };
  return null;
}

// R129 (0337): from the row's STUDIO's own connected number (Helm's helm_notice / helm_task_assigned / helm_event_reminder
// templates in the studio's account). No connected number -> "skipped" (as before when WhatsApp was not configured).
// A refused token marks the studio's account "error" (waPost); other refusals are retried ("failed" -> retry).
// deno-lint-ignore no-explicit-any
let waAdmin: any = null;
async function sendWhatsApp(to: string, text: string, kind: WaKind = "general", sender: WaSender | null = null): Promise<Res> {
  if (!sender || !PHONE.test(to) || !text) return "skipped";
  const content = noticeContent(kind, text);
  if (!content) return "skipped";
  const r = await waPost(waAdmin, sender, { to, ...content });
  if (r.ok) return "sent";
  return r.kind === "recipient" || r.kind === "token" || r.kind === "permission" ? "skipped" : "failed";
}

// 0155: last STOP check right before a WhatsApp send. "skipped" = the number replied STOP,
// "failed" = could not check (the row is retried later), null = OK to send.
// deno-lint-ignore no-explicit-any
async function waStopped(admin: any, to: string): Promise<Res | null> {
  try {
    const { data, error } = await admin.rpc("wa_recipient_opted_out", { p_phone: to });
    if (error) { L.error("stop check failed", errTag(error)); return "failed"; }
    return data === true ? "skipped" : null;
  } catch (e) { L.error("stop check error", errTag(e)); return "failed"; }
}

// R130 (0338): an assign row's studio + template + fields (service role reads; null when the row / columns are missing)
// deno-lint-ignore no-explicit-any
async function assignMeta(admin: any, id: string): Promise<{ org_id: string; template: string | null; params: unknown } | null> {
  try {
    const { data, error } = await admin.from("assign_notify_outbox").select("org_id, template, params").eq("id", id).maybeSingle();
    return error || !data ? null : { org_id: String(data.org_id || ""), template: data.template || null, params: data.params };
  } catch (_) { return null; }
}
// deno-lint-ignore no-explicit-any
async function assignWa(admin: any, id: string, wamid: string | null, status: "sent" | "failed" | "not_set_up"): Promise<void> {
  try { const { error } = await admin.rpc("assign_notify_wamid", { p_id: id, p_wamid: wamid, p_status: status }); if (error && !/PGRST202|42883/.test(String(error.code || ""))) L.error("wamid not saved", errTag(error)); }
  catch (e) { L.error("wamid error", errTag(e)); }
}

// 0132: assignment text from the database + the person's own task link (path is validated
// against the one shape the database writes; the host is always APP_URL, never the database)
const ASSIGN_LINK = /^work\.html\?token=[0-9a-f-]{36}$/;
export function assignMessage(text: string, linkPath: string, origin: string): string {
  const t = String(text || "").slice(0, 880).trim();
  if (!t) return "";
  return ASSIGN_LINK.test(linkPath) ? t + " " + origin + "/" + linkPath : t;
}

// the message for one claimed row (text from the database + the deep link for forwards)
export function messageFor(purpose: string, payload: Record<string, unknown>, origin: string): { subject: string; text: string } {
  if (purpose === "invite_site") return inviteSiteMessage(payload, origin);   // 0195: no link / bad row -> "" -> skipped
  if (purpose === "booklet_link") return bookletMessage(payload, origin);     // 0200: same rule
  if (purpose === "quote_expiry") return quoteExpiryMessage(payload, origin); // 0262: same rule
  const text = String(payload?.text ?? "").slice(0, 900);
  if (purpose === "wa_forward") {
    const link = absoluteLink(origin, payload);
    return { subject: "", text: link ? text + "\n" + link : text };
  }
  return { subject: String(payload?.subject ?? "A message from your planner"), text };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  const log = logger("comms-dispatch", req);   // R142: JSON log lines with the request id
  const report = sentryOnce(req);              // R142: one Sentry event per run at most
  try {
    if (!commsOn(Deno.env.get("HELM_COMMS_ENABLED"))) return json({ status: "dormant" });
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
    const wait = await checkLimits([["comms:ip:" + clientIp(req), 30, 60_000]]);
    if (wait) return new Response(JSON.stringify({ error: "too many requests" }), { status: 429, headers: { "Content-Type": "application/json", "Retry-After": String(wait) } });
    await readBodyCapped(req);
    const ok = await secretMatches(req.headers.get("x-helm-cron-secret") || "", Deno.env.get("HELM_COMMS_SECRET") || "");
    if (!ok) return json({ error: "unauthorized" }, 401);

    const batch = Math.min(100, Math.max(1, Number(Deno.env.get("COMMS_BATCH")) || 25));
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    waAdmin = admin;
    const waSenderOf = senderCache(admin);   // R129: one studio-number lookup per studio per run
    const { data: rows, error } = await admin.rpc("comms_outbox_claim", { p_limit: batch });
    if (error) { log.error("claim failed", errTag(error)); report.error(error); return json({ error: "internal error" }, 500); }

    const origin = appOrigin();
    const counts = { sent: 0, skipped: 0, failed: 0, invalid: 0 };
    // R107: a studio row's Reply-To - its own reply-to (0150), else business e-mail, else the owner's (one lookup per studio)
    const rtCache = new Map<string, string>();
    const withReply = async (lane: string, rowId: string, ident: Identity): Promise<Identity> =>
      ({ ...ident, reply_to: (await rowReplyTo(admin, lane, rowId, ident.reply_to, { env, cache: rtCache })) || null });
    for (const r of (Array.isArray(rows) ? rows : [])) {
      const id = String(r?.id ?? "");
      if (!UUIDISH.test(id)) { counts.invalid++; continue; }
      const purpose = String(r?.purpose ?? ""), channel = String(r?.channel ?? ""), to = String(r?.to ?? "");
      const payload = (r?.payload && typeof r.payload === "object") ? r.payload : {};
      const msg = messageFor(purpose, payload, origin);
      let res: Res = "skipped";
      if (!trialRowAllowed(purpose, channel, payload)) res = "skipped";   // 0212: free trial = link e-mails only
      else if (channel === "email" && purpose !== "wa_forward") {
        // 0150: sender name / reply-to of the row's studio (a database without 0150 -> defaults)
        let ident: Identity = {};
        try { const { data } = await admin.rpc("comms_outbox_email_identity", { p_id: id }); if (data && typeof data === "object") ident = data as Identity; } catch (_) { /* defaults */ }
        ident = await withReply("outbox", id, ident);
        let extra: Extra | null = { footer: txFooter(purpose === "invite_site" || purpose === "booklet_link" ? "client_link" : "pay_reminder", { app: origin, address: postalAddress(env) }) };
        if (purpose === "quote_expiry") extra = { footer: txFooter("client_link", { app: origin, address: postalAddress(env) }) };   // 0262: a client-link reminder
        if (NON_TRANSACTIONAL.has(purpose)) {
          let u: any = null;
          try { const { data } = await admin.rpc("comms_outbox_unsub", { p_id: id }); u = data; } catch (_) { u = null; }
          extra = marketingExtra(u, String(payload.studio ?? "") || "your event planner", "you asked " + (String(payload.studio ?? "") || "this planner") + " about an event", origin);
        }
        res = extra ? await sendEmail(id, to, msg.subject, msg.text, String(payload.studio ?? ""), ident, extra) : "skipped";
      }
      else if (channel === "whatsapp") res = (await waStopped(admin, to)) ?? await sendWhatsApp(to, msg.text, purpose === "wa_forward" && String(payload.type ?? "") === "event_reminder" ? "event_reminder" : "general",
        await waSenderOf(await orgOfRow(admin, "comms_outbox", id)));
      const { error: mErr } = await admin.rpc("comms_outbox_mark", { p_id: id, p_status: res === "failed" ? "retry" : res });
      if (mErr) { log.error("mark failed", errTag(mErr)); report.error(mErr); counts.failed++; continue; }
      counts[res]++;
    }
    // 0184: retention settings once per run, so the day 5 / 7 / 8 copy can say how long data is kept
    // (a database without 0184, or the switch off -> null / off -> the original "nothing is deleted" copy)
    let retention: { delete_enabled?: boolean; retention_days?: number } | null = null;
    try { const { data, error } = await admin.rpc("trial_retention_mail_settings"); if (!error && data && typeof data === "object") retention = data; } catch (_) { retention = null; }
    // 0120: free-trial reminder e-mails (a database without 0120 just has nothing to claim)
    const { data: trows, error: tErr } = await admin.rpc("trial_reminder_email_claim", { p_limit: batch });
    if (tErr) log.error("trial claim skipped", errTag(tErr));
    for (const r of (Array.isArray(trows) ? trows : [])) {
      const id = String(r?.id ?? ""), to = String(r?.to ?? "");
      if (!UUIDISH.test(id)) { counts.invalid++; continue; }
      const msg = trialReminderEmail(String(r?.milestone ?? ""), String(r?.studio ?? ""), String(r?.ends_at ?? ""), String(r?.timezone ?? ""), origin, retention);
      // trial nudges are Helm's own non-transactional mail: unsubscribe is per address for Helm (org null)
      let u: any = null;
      if (msg) {
        try {
          const [o, t] = await Promise.all([admin.rpc("email_is_opted_out", { p_org: null, p_email: to }), admin.rpc("email_unsub_token", { p_org: null, p_email: to })]);
          if (!o.error && !t.error) u = { ok: true, opted_out: o.data === true, token: t.data };
        } catch (_) { u = null; }
      }
      const extra = msg ? marketingExtra(u, "Helm", "you started a free trial of Helm", origin) : null;
      const res: Res = msg && extra ? await sendEmail(id, to, msg.subject, msg.text, "Helm", {}, extra) : "skipped";
      const { error: mErr } = await admin.rpc("trial_reminder_email_mark", { p_id: id, p_status: res === "failed" ? "retry" : res });
      if (mErr) { log.error("trial mark failed", errTag(mErr)); report.error(mErr); counts.failed++; continue; }
      counts[res]++;
    }
    // 0184: post-trial mails to the studio owner (a database without 0184 just has nothing to claim).
    // Deletion warnings are service notices (transactional footer); the follow-ups are nudges (Helm unsubscribe).
    const { data: rrows, error: rErr } = await admin.rpc("trial_retention_email_claim", { p_limit: batch });
    if (rErr) log.error("retention claim skipped", errTag(rErr));
    // R124 (0333): Day 0 / 2 / 14 have their own claim, so an older dispatcher can never mark them skipped; same mark.
    const { data: frows, error: fErr } = await admin.rpc("trial_followup_email_claim", { p_limit: batch });
    if (fErr) log.error("follow-up claim skipped", errTag(fErr));
    for (const r of [...(Array.isArray(rrows) ? rrows : []), ...(Array.isArray(frows) ? frows : [])]) {
      const id = String(r?.id ?? ""), to = String(r?.to ?? ""), kind = String(r?.kind ?? "");
      if (!UUIDISH.test(id)) { counts.invalid++; continue; }
      const msg = trialRetentionEmail(kind, String(r?.studio ?? ""), { deleteOn: String(r?.delete_on ?? ""), expiredAt: String(r?.expired_at ?? ""),
        timeZone: String(r?.timezone ?? ""), retentionDays: Number(r?.retention_days) }, origin);
      let extra: Extra | null = null;
      if (msg && RETENTION_NOTICE_KINDS.includes(kind)) extra = { footer: txFooter(RETENTION_TX_REASON, { app: origin, address: postalAddress(env) }) };
      else if (msg) {
        let u: any = null;
        try {
          const [o, t] = await Promise.all([admin.rpc("email_is_opted_out", { p_org: null, p_email: to }), admin.rpc("email_unsub_token", { p_org: null, p_email: to })]);
          if (!o.error && !t.error) u = { ok: true, opted_out: o.data === true, token: t.data };
        } catch (_) { u = null; }
        extra = marketingExtra(u, "Helm", FOLLOWUP_REASON, origin);
      }
      const follow = FOLLOWUP_KINDS.includes(kind);
      const html = msg && extra && msg.html ? placeFooter(msg.html, extra.footer) : undefined;
      const res: Res = msg && extra ? await sendEmail(id, to, msg.subject, msg.text, "Helm", follow ? { reply_to: FOLLOWUP_REPLY_TO } : {}, extra, html) : "skipped";
      const { error: mErr } = await admin.rpc("trial_retention_email_mark", { p_id: id, p_status: res === "failed" ? "retry" : res });
      if (mErr) { log.error("retention mark failed", errTag(mErr)); report.error(mErr); counts.failed++; continue; }
      counts[res]++;
    }
    // 0132: "you've been assigned ..." WhatsApp to staff (a database without 0132 has nothing to claim)
    const { data: arows, error: aErr } = await admin.rpc("assign_notify_claim", { p_limit: batch });
    if (aErr) log.error("assign claim skipped", errTag(aErr));
    for (const r of (Array.isArray(arows) ? arows : [])) {
      const id = String(r?.id ?? ""), to = String(r?.to ?? "");
      if (!UUIDISH.test(id)) { counts.invalid++; continue; }
      const text = assignMessage(String(r?.text ?? ""), String(r?.link_path ?? ""), origin);
      // R130 (0338): the row's own template + fields (task assigned / open shift / run-sheet reminder); older rows or a
      // failed lookup -> the one-box notice as before. The WhatsApp id is kept so Meta's ticks show Delivered / Read.
      const meta = await assignMeta(admin, id);
      const sender = await waSenderOf(meta?.org_id ?? await orgOfRow(admin, "assign_notify_outbox", id));
      const linkPath = String(r?.link_path ?? "");
      const link = ASSIGN_LINK.test(linkPath) ? origin + "/" + linkPath : "";
      let res: Res = "skipped";
      if (!text) res = "skipped";
      else if (!sender) { res = "skipped"; await assignWa(admin, id, null, "not_set_up"); }
      else if (meta && meta.template && fieldContent(meta.template, meta.params, link)) {
        const stop = await waStopped(admin, to);
        if (stop) res = stop;
        else {
          const w = await waPost(admin, sender, { to, ...fieldContent(meta.template, meta.params, link)! });
          res = w.ok ? "sent" : (w.kind === "recipient" || w.kind === "token" || w.kind === "permission" || w.kind === "template") ? "skipped" : "failed";
          if (w.ok || res === "skipped") await assignWa(admin, id, w.wamid, w.ok ? "sent" : "failed");
        }
      }
      else res = (await waStopped(admin, to)) ?? await sendWhatsApp(to, text, "task_assigned", sender);
      const { error: mErr } = await admin.rpc("assign_notify_mark", { p_id: id, p_status: res === "failed" ? "retry" : res });
      if (mErr) { log.error("assign mark failed", errTag(mErr)); report.error(mErr); counts.failed++; continue; }
      counts[res]++;
    }
    // R130 (0338): task reminders, late reminders and office alerts (task_reminder_tick queues them every minute).
    // From the studio's own number only; not connected -> "not_set_up" (the Live Status line says so). A database
    // without 0338 just has nothing to claim.
    const { data: rmRows, error: trErr } = await admin.rpc("task_wa_claim", { p_limit: batch });
    if (trErr && !/PGRST202|42883/.test(String(trErr.code || ""))) log.error("reminder claim skipped", errTag(trErr));
    for (const r of (Array.isArray(rmRows) ? rmRows : [])) {
      const id = String(r?.id ?? ""), to = String(r?.to ?? "");
      if (!UUIDISH.test(id)) { counts.invalid++; continue; }
      const sender = await waSenderOf(String(r?.org_id ?? ""));
      const lp = String(r?.link_path ?? "");
      const content = fieldContent(String(r?.template ?? ""), r?.params, /^(work\.html\?token=|ops\.html\?quote=)[0-9a-f-]{36}$/.test(lp) ? origin + "/" + lp : "");
      let st = "skipped", wamid: string | null = null, reason: string | null = null;
      if (!sender) { st = "not_set_up"; reason = "whatsapp_not_connected"; }
      else if (!content || !PHONE.test(to)) { st = "skipped"; reason = "bad_fields"; }
      else {
        const w = await waPost(admin, sender, { to, ...content });
        if (w.ok) { st = "sent"; wamid = w.wamid; }
        else if (w.kind === "recipient" || w.kind === "token" || w.kind === "permission" || w.kind === "template") { st = "failed"; reason = w.kind; }
        else { st = "retry"; reason = w.kind; }
      }
      const { error: tmErr } = await admin.rpc("task_wa_mark", { p_id: id, p_status: st, p_wamid: wamid, p_reason: reason });
      if (tmErr) { log.error("reminder mark failed", errTag(tmErr)); report.error(tmErr); counts.failed++; continue; }
      counts[st === "sent" ? "sent" : st === "retry" || st === "failed" ? "failed" : "skipped"]++;
    }
    // 0241: delivery / arrival reminders (a database without 0241 just has nothing to claim). E-mail only.
    const { data: drows, error: dErr } = await admin.rpc("delivery_reminder_claim", { p_limit: batch });
    if (dErr) log.error("delivery claim skipped", errTag(dErr));
    for (const r of (Array.isArray(drows) ? drows : [])) {
      const id = String(r?.id ?? ""), to = String(r?.to ?? "");
      if (!UUIDISH.test(id)) { counts.invalid++; continue; }
      const msg = deliveryMessage(r, origin);
      const ident: Identity = await withReply("delivery", id, (r?.identity && typeof r.identity === "object") ? r.identity as Identity : {});
      const extra: Extra = { footer: txFooter("delivery", { app: origin, address: postalAddress(env) }) };
      const res: Res = msg.text ? await sendEmail(id, to, msg.subject, msg.text, String(r?.studio ?? ""), ident, extra) : "skipped";
      const { error: mErr } = await admin.rpc("delivery_reminder_mark", { p_id: id, p_status: res === "failed" ? "retry" : res });
      if (mErr) { log.error("delivery mark failed", errTag(mErr)); report.error(mErr); counts.failed++; continue; }
      counts[res]++;
    }
    // 0256: vendor requests + "still waiting" reminders (e-mail lane only; WhatsApp rows stay queued for a future
    // lane; a database without 0256 just has nothing to claim). The claim re-checks each row and mints a fresh link.
    const { data: vrows, error: vErr } = await admin.rpc("vendor_request_claim", { p_limit: batch, p_channel: "email" });
    if (vErr) log.error("vendor request claim skipped", errTag(vErr));
    for (const r of (Array.isArray(vrows) ? vrows : [])) {
      const id = String(r?.id ?? ""), to = String(r?.to ?? "");
      if (!UUIDISH.test(id)) { counts.invalid++; continue; }
      const msg = vendorRequestMessage(r, origin);
      const ident: Identity = await withReply("vendor", id, (r?.identity && typeof r.identity === "object") ? r.identity as Identity : {});
      const extra: Extra = { footer: txFooter(VENDOR_TX_REASON, { app: origin, address: postalAddress(env) }) };
      const res: Res = msg.text ? await sendEmail(id, to, msg.subject, msg.text, String(r?.studio ?? ""), ident, extra) : "skipped";
      const { error: mErr } = await admin.rpc("vendor_request_mark", { p_id: id, p_status: res === "failed" ? "retry" : res });
      if (mErr) { log.error("vendor request mark failed", errTag(mErr)); report.error(mErr); counts.failed++; continue; }
      counts[res]++;
    }
    // 0269: run-sheet reminders (e-mail lane; a database without 0269 just has nothing to claim)
    const { data: rsrows, error: rsErr } = await admin.rpc("runsheet_reminder_claim", { p_limit: batch });
    if (rsErr) log.error("run-sheet claim skipped", errTag(rsErr));
    for (const r of (Array.isArray(rsrows) ? rsrows : [])) {
      const id = String(r?.id ?? ""), to = String(r?.to ?? "");
      if (!UUIDISH.test(id)) { counts.invalid++; continue; }
      const msg = runsheetReminderMessage(r, origin);
      const ident: Identity = await withReply("runsheet", id, (r?.identity && typeof r.identity === "object") ? r.identity as Identity : {});
      const extra: Extra = { footer: txFooter(RUNSHEET_TX_REASON, { app: origin, address: postalAddress(env) }) };
      const res: Res = msg.text && EMAIL.test(to) ? await sendEmail(id, to, msg.subject, msg.text, String(r?.studio ?? ""), ident, extra) : "skipped";
      const { error: mErr } = await admin.rpc("runsheet_reminder_mark", { p_id: id, p_status: res === "failed" ? "retry" : res });
      if (mErr) { log.error("run-sheet mark failed", errTag(mErr)); report.error(mErr); counts.failed++; continue; }
      counts[res]++;
    }
    // 0269: instant replies to the public enquiry form (a database without 0269 has nothing to claim)
    const { data: eqrows, error: eqErr } = await admin.rpc("enquiry_reply_claim", { p_limit: batch });
    if (eqErr) log.error("enquiry reply claim skipped", errTag(eqErr));
    for (const r of (Array.isArray(eqrows) ? eqrows : [])) {
      const id = String(r?.id ?? ""), to = String(r?.to ?? "");
      if (!UUIDISH.test(id)) { counts.invalid++; continue; }
      const msg = enquiryReplyMessage(r);
      const ident: Identity = await withReply("enquiry", id, (r?.identity && typeof r.identity === "object") ? r.identity as Identity : {});
      const extra: Extra = { footer: txFooter(ENQUIRY_TX_REASON, { app: origin, address: postalAddress(env) }) };
      const res: Res = msg.text && EMAIL.test(to) ? await sendEmail(id, to, msg.subject, msg.text, String(r?.studio ?? ""), ident, extra) : "skipped";
      const { error: mErr } = await admin.rpc("enquiry_reply_mark", { p_id: id, p_status: res === "failed" ? "retry" : res });
      if (mErr) { log.error("enquiry reply mark failed", errTag(mErr)); report.error(mErr); counts.failed++; continue; }
      counts[res]++;
    }
    // 0244: Helm's own notices - a plan request to sales@helm.events, "Ask my admin to upgrade" to the studio's
    // admins (recipients resolved by the claim, never from the row; a database without 0244 has nothing to claim)
    const { data: hrows, error: hErr } = await admin.rpc("helm_notice_outbox_claim", { p_limit: batch });
    if (hErr) log.error("notice claim skipped", errTag(hErr));
    for (const r of (Array.isArray(hrows) ? hrows : [])) {
      const id = String(r?.id ?? ""), kind = String(r?.kind ?? "");
      if (!UUIDISH.test(id)) { counts.invalid++; continue; }
      const data = (r?.data && typeof r.data === "object") ? r.data : {};
      const msg = helmNoticeEmail(kind, data, origin);
      const tos = (Array.isArray(r?.to) ? r.to : []).map((x: unknown) => String(x ?? "")).filter((x: string) => EMAIL.test(x)).slice(0, 20);
      let res: Res = "skipped";
      if (msg && tos.length) {
        const extra: Extra = { footer: txFooter((NOTICE_TX_REASON as Record<string, string>)[kind] || "you use Helm", { app: origin, address: postalAddress(env) }) };
        // a sales request / a Contact sales enquiry / a suggestion (0271): replying goes straight to the person who asked
        const ident: Identity = (kind === "sales_request" || kind === "sales_enquiry" || kind === "suggestion") ? { reply_to: String(data.email ?? "") || null } : {};
        const outs: Res[] = [];
        for (let i = 0; i < tos.length; i++) outs.push(await sendEmail(id + "-" + i, tos[i], msg.subject, msg.text, "Helm", ident, extra));
        res = outs.includes("sent") ? "sent" : outs.includes("failed") ? "failed" : "skipped";
      }
      const { error: mErr } = await admin.rpc("helm_notice_outbox_mark", { p_id: id, p_status: res === "failed" ? "retry" : res });
      if (mErr) { log.error("notice mark failed", errTag(mErr)); report.error(mErr); counts.failed++; continue; }
      counts[res]++;
    }
    // R119 (0327): welcome e-mails - only while the database switch is on; a database without 0327 -> nothing claimed.
    // R154g: HELM_WELCOME_EMAILS_ENABLED set to anything but "true" -> the lane is off (nothing claimed, rows stay queued).
    if (welcomeLaneOn(Deno.env.get("HELM_WELCOME_EMAILS_ENABLED"))) try {
      const w = await runWelcomeBatch(admin, batch, { env });
      if (w.error) log.error("welcome claim skipped", errTag(w.error));
      counts.sent += w.counts.sent; counts.skipped += w.counts.skipped; counts.failed += w.counts.failed; counts.invalid += w.counts.invalid;
    } catch (e) { log.error("welcome lane failed", errTag(e)); report.error(e); }
    log.info("run", counts);
    if (counts.failed > 0) report.fail("send_failed");   // failed sends (retried) or rows that could not be marked
    return json({ status: "ok", ...counts });
  } catch (e) {
    if (e instanceof BodyTooLarge) return json({ error: "payload too large" }, 413);
    log.error("comms-dispatch error", errTag(e));
    report.error(e);
    return json({ error: "internal error" }, 500);
  }
});
