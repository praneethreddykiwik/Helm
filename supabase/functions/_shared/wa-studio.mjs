// _shared/wa-studio.mjs - R129 (0337): pure helpers for sending WhatsApp from a STUDIO's own number (no network, no Deno
// APIs, so node tests cover them). The studio connects its WhatsApp Business number on the Integrations page; Helm then
// creates the message templates below in the studio's own WhatsApp account (Meta must approve each one before a business
// may START a chat with it). Template names / variable counts are the ones the senders use:
//   wa-proposal + send-otp: proposal_sent, proposal_reminder, proposal_approved_pay, payment_received, proposal_approval_otp
//   comms-dispatch + pkg-client-notify + the Integrations test: helm_notice, helm_task_assigned, helm_event_reminder
// Helm's OWN number (WHATSAPP_TOKEN / WHATSAPP_PHONE_ID secrets) is never used for a studio's messages.

export const STUDIO_LANG = "en";
export const SAMPLE_TOKEN = "00000000-0000-4000-8000-000000000000";
const NAME = /^[a-z0-9_]{1,64}$/;

// the Graph API version: WHATSAPP_API_VERSION when it looks like "v21.0", else v21.0
export function graphVersion(env) {
  const v = String((env && env("WHATSAPP_API_VERSION")) || "");
  return /^v[0-9]{1,2}\.[0-9]$/.test(v) ? v : "v21.0";
}

// the site the template buttons open (APP_URL origin, https only), default the production site
export function siteOrigin(appUrl) {
  try {
    const u = new URL(String(appUrl || "https://www.helm.events"));
    return u.protocol === "https:" ? u.origin : "https://www.helm.events";
  } catch (_) { return "https://www.helm.events"; }
}

const urlButton = (text, origin) => ({ type: "URL", text, url: origin + "/portal.html?token={{1}}", example: [origin + "/portal.html?token=" + SAMPLE_TOKEN] });
const utility = (name, body, example, button) => ({
  name, language: STUDIO_LANG, category: "UTILITY",
  components: [{ type: "BODY", text: body, example: { body_text: [example] } }].concat(button ? [{ type: "BUTTONS", buttons: [button] }] : []),
});

// the templates Helm creates in a studio's WhatsApp account (Meta "create template" bodies)
export function templateCatalogue(appUrl) {
  const o = siteOrigin(appUrl);
  return [
    utility("proposal_sent",
      "Hi {{1}}, your planner {{2}} has shared the proposal for your {{3}} on {{4}}. The total amount is {{5}}. Please tap the button below to review the details and approve it. Reply STOP to opt out.",
      ["Priya", "Aurora Events", "Wedding", "12 Dec 2026", "INR 2,36,000"], urlButton("Review proposal", o)),
    utility("proposal_reminder",
      "Hi {{1}}, this is a friendly reminder from {{2}}. Your proposal for your {{3}} on {{4}}, with a total of {{5}}, is still waiting for your approval. Tap the button below to review it. Reply STOP to opt out.",
      ["Priya", "Aurora Events", "Wedding", "12 Dec 2026", "INR 2,36,000"], urlButton("Review proposal", o)),
    utility("proposal_approved_pay",
      "Thank you {{1}}, your {{2}} on {{3}} is now approved. The amount to pay is {{4}}. Please tap the button below to view your booking and pay securely.",
      ["Priya", "Wedding", "12 Dec 2026", "INR 2,36,000"], urlButton("Pay now", o)),
    utility("payment_received",
      "Hi {{1}}, your planner {{2}} has received your payment for your {{3}}. Thank you! Tap below to see your receipt and booking.",
      ["Priya", "Aurora Events", "Wedding"], urlButton("View booking", o)),
    {
      name: "proposal_approval_otp", language: STUDIO_LANG, category: "AUTHENTICATION", message_send_ttl_seconds: 600,
      components: [
        { type: "BODY", add_security_recommendation: true },
        { type: "FOOTER", code_expiration_minutes: 10 },
        { type: "BUTTONS", buttons: [{ type: "OTP", otp_type: "COPY_CODE", text: "Copy code" }] },
      ],
    },
    utility("helm_notice", "Update from your event planner: {{1}}. Reply STOP to opt out.",
      ["Your payment of INR 50,000 for the Rao Wedding is due on 12 Dec 2026. Pay here: " + o + "/portal.html"]),
    utility("helm_task_assigned", "New assignment from your studio: {{1}}. Thank you.",
      ["Stage setup at 4 PM for Rao Wedding. Open your link: " + o + "/work"]),
    utility("helm_event_reminder", "Event reminder from your studio: {{1}}. See you there.",
      ["Rao Wedding is on 12 Dec 2026 at Grand Convention Centre"]),
  ].concat(fieldTemplates(o));
}

// R130 (U-31): one fixed template per staff / vendor / office message, each with its OWN fields (only the fields change).
// Every link is a full Helm address in the text (the sender fills "@link"). Order of fields = FIELDS[name].
export const FIELDS = {
  staff_task_assigned: ["name", "task", "event", "date", "time", "venue", "link"],
  staff_task_reminder: ["name", "task", "event", "time", "minutes left", "link"],
  staff_task_overdue: ["name", "task", "event", "time", "link"],
  staff_task_changed: ["name", "task", "event", "what changed"],
  staff_open_shift: ["name", "role", "event", "date", "start", "end", "venue", "link"],
  staff_shift_result: ["name", "role", "event", "date", "result", "link"],
  staff_leave_result: ["name", "date", "result", "reason"],
  office_staff_alert: ["staff name", "what happened", "task", "event", "date", "reason", "link"],
  vendor_request: ["vendor", "studio", "work", "event", "date", "time", "venue", "amount", "reply by", "link"],
  vendor_follow_up: ["vendor", "work", "event", "reply by", "link"],
  vendor_delivery_reminder: ["vendor", "work", "event", "date", "time", "venue", "link"],
  vendor_invoice_update: ["vendor", "invoice no", "amount", "result", "note", "link"],
  crew_runsheet_reminder: ["name", "time", "event", "item", "link"],
};
// what each one is for (the Integrations card) and whether Helm sends it today
export const FIELD_TEMPLATE_INFO = {
  staff_task_assigned: ["Task assigned", "Staff", true], staff_task_reminder: ["Task reminder", "Staff", true],
  staff_task_overdue: ["Task overdue", "Staff", true], staff_task_changed: ["Task changed or removed", "Staff", false],
  staff_open_shift: ["Open shift available", "Staff", true], staff_shift_result: ["Shift confirmed or not given", "Staff", false],
  staff_leave_result: ["Leave approved or declined", "Staff", false], office_staff_alert: ["Staff alert", "Office", true],
  vendor_request: ["Vendor request", "Vendor", false], vendor_follow_up: ["Vendor follow-up", "Vendor", false],
  vendor_delivery_reminder: ["Delivery reminder", "Vendor", false], vendor_invoice_update: ["Invoice update", "Vendor", false],
  crew_runsheet_reminder: ["Run-sheet reminder", "Crew", true],
};
function fieldTemplates(o) {
  const L = o + "/work.html?token=" + SAMPLE_TOKEN;
  return [
    utility("staff_task_assigned", "Hi {{1}}, you have been given a new task: {{2}} for the {{3}} event on {{4}} at {{5}}. The place is {{6}}. Please open your task link to accept or decline this task and to see all of the details: {{7}} Thank you for your help.",
      ["Ravi", "Stage lights", "Rao Wedding", "12 Dec 2026", "12:30 PM", "Grand Convention Centre", L]),
    utility("staff_task_reminder", "Hi {{1}}, this is a reminder that your task {{2}} for the {{3}} event starts at {{4}}, which is in {{5}} minutes. Please open your task link to see the details: {{6}} Please be on time, thank you.",
      ["Ravi", "Stage lights", "Rao Wedding", "12:30 PM", "10", L]),
    utility("staff_task_overdue", "Hi {{1}}, the task {{2}} for the {{3}} event was due at {{4}} and has not started yet. Please start it now, or tell the office what is wrong, using your task link: {{5}} Thank you.",
      ["Ravi", "Stage lights", "Rao Wedding", "12:30 PM", L]),
    utility("staff_task_changed", "Hi {{1}}, your task {{2}} for the {{3}} event has been changed. What changed: {{4}}. Please open your task link to check all of the details. Thank you.",
      ["Ravi", "Stage lights", "Rao Wedding", "the start time moved to 1:00 PM"]),
    utility("staff_open_shift", "Hi {{1}}, a new open shift is available for you: {{2}} for the {{3}} event on {{4}}, from {{5}} until {{6}}, at {{7}}. If you would like to work this shift, please take it using your staff link: {{8}} Shifts are given on a first come, first served basis. Thank you.",
      ["Ravi", "Decoration", "Rao Wedding", "12 Dec 2026", "10:00 AM", "6:00 PM", "Grand Convention Centre", L]),
    utility("staff_shift_result", "Hi {{1}}, here is the update on your request for the {{2}} shift at {{3}} on {{4}}. The office has marked your request as {{5}}. You can see the full details on your staff link here: {{6}} Thank you for your help.",
      ["Ravi", "Decoration", "Rao Wedding", "12 Dec 2026", "confirmed", L]),
    utility("staff_leave_result", "Hi {{1}}, here is the answer to your request to be off work on {{2}}. The office has marked your request as {{3}}. A note from the office: {{4}}. Thank you.",
      ["Ravi", "12 Dec 2026", "approved", "enjoy the family function"]),
    utility("office_staff_alert", "Staff alert for the office: {{1}} needs attention because of this: {{2}}. The task is {{3}} for the {{4}} event on {{5}}. The reason given is {{6}}. Please open the event in Helm to see the details and act on it: {{7}} Thank you.",
      ["Ravi Kumar", "task not started", "Stage lights", "Rao Wedding", "12 Dec 2026 12:30 PM", "no start after 3 reminders", o + "/ops.html?quote=" + SAMPLE_TOKEN]),
    utility("vendor_request", "Hello {{1}}, this is {{2}}. We would like to book you for {{3}} at the {{4}} event on {{5}} at {{6}}. The venue is {{7}} and the amount offered is {{8}}. Please tell us if you can take this booking by {{9}} using this secure link: {{10}} Thank you, we look forward to working with you.",
      ["Sri Flowers", "Aurora Events", "stage flowers", "Rao Wedding", "12 Dec 2026", "10:00 AM", "Grand Convention Centre", "INR 25,000", "8 Dec 2026", o + "/vendor-request.html?token=" + SAMPLE_TOKEN]),
    utility("vendor_follow_up", "Hello {{1}}, this is a friendly reminder about our booking request for {{2}} at the {{3}} event. Please tell us if you can take this booking by {{4}} using this secure link: {{5}} Thank you.",
      ["Sri Flowers", "stage flowers", "Rao Wedding", "8 Dec 2026", o + "/vendor-request.html?token=" + SAMPLE_TOKEN]),
    utility("vendor_delivery_reminder", "Hello {{1}}, this is a reminder about your booking for {{2}} at the {{3}} event. Please deliver on {{4}} by {{5}} at this venue: {{6}}. You can see the full booking details and contact the studio using this link: {{7}} Thank you for your support.",
      ["Sri Flowers", "stage flowers", "Rao Wedding", "12 Dec 2026", "10:00 AM", "Grand Convention Centre", o + "/vendor-request.html?token=" + SAMPLE_TOKEN]),
    utility("vendor_invoice_update", "Hello {{1}}, there is an update on your invoice {{2}} for the amount of {{3}}. The studio has marked this invoice as {{4}}. A note from the studio: {{5}}. You can see the full details using this link: {{6}} Thank you.",
      ["Sri Flowers", "INV-102", "INR 25,000", "approved", "paid on 15 Dec", o + "/vendor-request.html?token=" + SAMPLE_TOKEN]),
    utility("crew_runsheet_reminder", "Hi {{1}}, this is a reminder from the event run sheet. At {{2}} during {{3}}, the next item is {{4}}. Please be ready at your position a few minutes early. You can open your run sheet here: {{5}} Thank you.",
      ["Ravi", "6:30 PM", "Rao Wedding", "Couple entry", L]),
  ];
}

// a field template message: "@link" becomes the full Helm link (or a plain note when the person has no link)
export function fieldContent(name, params, linkUrl) {
  const want = FIELDS[name];
  if (!want || !Array.isArray(params) || params.length !== want.length) return null;
  const text = params.map((p) => {
    const v = String(p == null ? "" : p) === "@link" ? (linkUrl || "ask the office for your link") : String(p == null ? "" : p);
    return { type: "text", text: v.replace(/[\r\n\t]+/g, " ").replace(/ {4,}/g, "   ").trim().slice(0, 300) || "-" };
  });
  return { type: "template", template: { name, language: { code: STUDIO_LANG }, components: [{ type: "body", parameters: text }] } };
}
export const CATALOGUE_NAMES = templateCatalogue().map((t) => t.name);

// Meta's template list -> { name: STATUS } for Helm's templates in STUDIO_LANG only (others are ignored)
export function templateStates(list) {
  const out = {};
  for (const t of Array.isArray(list) ? list : []) {
    const name = String((t && t.name) || ""), lang = String((t && t.language) || "");
    if (!CATALOGUE_NAMES.includes(name) || lang !== STUDIO_LANG) continue;
    const st = String((t && t.status) || "").toUpperCase();
    if (/^[A-Z_]{1,30}$/.test(st)) out[name] = st;
  }
  return out;
}
// the catalogue templates still to create (not in Meta's list in STUDIO_LANG yet)
export function templatesToCreate(states, appUrl) {
  const have = states && typeof states === "object" ? states : {};
  return templateCatalogue(appUrl).filter((t) => !have[t.name]);
}
// one line for the studio: "6 of 8 approved, 2 waiting for Meta"
export function templateSummary(states) {
  const s = states && typeof states === "object" ? states : {};
  const n = CATALOGUE_NAMES.length;
  let ok = 0, wait = 0, bad = 0, missing = 0;
  for (const name of CATALOGUE_NAMES) {
    const v = s[name];
    if (!v) missing++; else if (v === "APPROVED") ok++; else if (v === "REJECTED" || v === "DISABLED" || v === "PAUSED") bad++; else wait++;
  }
  return { total: n, approved: ok, waiting: wait, rejected: bad, missing, ready: ok === n };
}

// Meta error -> what it means for the studio. kind: token | permission | number | template | limit | recipient | other
export function graphError(status, body) {
  const e = (body && body.error) || {};
  const code = Number(e.code) || 0, sub = Number(e.error_subcode) || 0;
  if (status === 401 || code === 190) return { kind: "token", text: "the access token stopped working - paste a new permanent token and save again" };
  if (code === 10 || code === 200 || (code >= 200 && code <= 299) || status === 403) return { kind: "permission", text: "the token is missing the whatsapp_business_messaging / whatsapp_business_management permission" };
  if (code === 100 && (sub === 2388023 || sub === 2388024 || /already exists/i.test(String(e.message || "")))) return { kind: "exists", text: "already exists" };
  // R156: template content refusals (wording) - never an ID problem, so they must not fall into "number" below
  if (CONTENT_SUBCODES[sub]) return { kind: "content", text: CONTENT_SUBCODES[sub][1] };
  if (code === 100 || code === 133010 || status === 404) return { kind: "number", text: "Meta does not know that phone number ID or account ID - check both numbers" };
  if (code === 132001 || code === 132000 || code === 132012 || code === 132015) return { kind: "template", text: "the message template is not approved yet in your WhatsApp account" };
  if (code === 131026 || code === 131021) return { kind: "recipient", text: "that number is not on WhatsApp" };
  if (code === 4 || code === 80007 || code === 130429 || code === 131048 || code === 131056 || status === 429) return { kind: "limit", text: "WhatsApp is limiting messages from this number - try again later" };
  return { kind: "other", text: "Meta refused it (status " + (Number(status) || 0) + (code ? ", code " + code : "") + ")" };
}

// connection check: Meta's phone-number answer + the account's numbers -> { ok, display, name, quality, error, code }
// R154h: code (number | not_in_account) is a short reason the page can explain - never a secret
export function verifyResult(phoneId, phone, wabaPhones) {
  const id = String(phoneId || "");
  if (!phone || typeof phone !== "object" || String(phone.id || "") !== id) return { ok: false, code: "number", error: "Meta did not return that phone number ID" };
  const list = Array.isArray(wabaPhones) ? wabaPhones : null;
  if (list && !list.some((p) => p && String(p.id || "") === id)) return { ok: false, code: "not_in_account", error: "that phone number ID is not in the WhatsApp Business Account you entered" };
  const display = String(phone.display_phone_number || "").replace(/[^0-9+ ()-]/g, "").trim().slice(0, 30);
  const name = String(phone.verified_name || "").replace(/[<>\r\n\t]/g, " ").trim().slice(0, 120);
  const quality = String(phone.quality_rating || "").replace(/[^A-Za-z_]/g, "").slice(0, 20);
  return { ok: true, display, name, quality };
}

// a one-variable notice for a studio sender ({{1}} = the text, one line, at most 1000 characters)
export function noticeContent(kind, text) {
  const name = kind === "task_assigned" ? "helm_task_assigned" : kind === "event_reminder" ? "helm_event_reminder" : "helm_notice";
  const t = String(text || "").replace(/[\r\n\t]+/g, " ").replace(/ {4,}/g, "   ").trim().slice(0, 1000);
  if (!t) return null;
  return { type: "template", template: { name, language: { code: STUDIO_LANG }, components: [{ type: "body", parameters: [{ type: "text", text: t }] }] } };
}
export const isTemplateName = (v) => NAME.test(String(v || ""));

// ==== R156: wording check, Meta's real reason per template, Template Library, health ====================================
// Meta does not publish the exact "too many variables for its length" threshold (error 2388293). Every template Meta took
// had 2+ fixed words per variable and every refused one had fewer, so Helm keeps a safe margin of 4.5.
export const WORDING = { minWordsPerVar: 4.5, bodyMax: 1024, buttonTextMax: 25, exampleMax: 300 };
const VAR = /\{\{(\d+)\}\}/g;
// fixed words per variable of a body text -> { vars, words, ratio }
export function wordStats(text) {
  const t = String(text || "");
  const vars = (t.match(VAR) || []).length;
  const words = t.replace(VAR, " ").split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
  return { vars, words, ratio: vars ? words / vars : Infinity };
}
// a template's problems (empty = fine). Authentication bodies are Meta's own fixed text, so only their shape is checked.
export function lintTemplate(t) {
  const out = [];
  if (!t || typeof t !== "object") return ["not a template"];
  if (!NAME.test(String(t.name || ""))) out.push("name must be lower case letters, digits and _ (at most 64)");
  const comps = Array.isArray(t.components) ? t.components : [];
  const body = comps.find((c) => c && c.type === "BODY");
  if (!body) return out.concat("no body");
  if (t.category === "AUTHENTICATION") {
    if (body.add_security_recommendation !== true) out.push("authentication body needs add_security_recommendation");
    return out;
  }
  const text = String(body.text || "");
  const st = wordStats(text);
  if (text.length > WORDING.bodyMax) out.push("body longer than " + WORDING.bodyMax + " characters");
  if (/^\s*\{\{\d+\}\}/.test(text)) out.push("body starts with a variable");
  if (/\{\{\d+\}\}[\s.!?]*$/.test(text)) out.push("body ends with a variable");
  if (/\{\{\d+\}\}[\s,.;:!?()-]*\{\{\d+\}\}/.test(text)) out.push("two variables next to each other");
  const nums = [...text.matchAll(VAR)].map((m) => Number(m[1]));
  if (nums.some((n, i) => n !== i + 1)) out.push("variables must be {{1}}, {{2}} ... in order");
  if (st.vars && st.ratio < WORDING.minWordsPerVar) out.push("too few fixed words per variable (" + st.ratio.toFixed(1) + ", needs " + WORDING.minWordsPerVar + ")");
  const ex = body.example && Array.isArray(body.example.body_text) ? body.example.body_text[0] : null;
  if (st.vars && (!Array.isArray(ex) || ex.length !== st.vars)) out.push("examples must match the variables");
  for (const v of Array.isArray(ex) ? ex : []) {
    if (/[\r\n\t]/.test(String(v))) out.push("an example has a new line or tab");
    if (String(v).length > WORDING.exampleMax) out.push("an example is too long");
  }
  for (const c of comps.filter((c) => c && c.type === "BUTTONS")) {
    for (const b of Array.isArray(c.buttons) ? c.buttons : []) if (String(b.text || "").length > WORDING.buttonTextMax) out.push("button text longer than " + WORDING.buttonTextMax);
  }
  return out;
}
export const lintCatalogue = (appUrl) => templateCatalogue(appUrl).map((t) => ({ name: t.name, problems: lintTemplate(t) })).filter((x) => x.problems.length);

// Meta error subcodes for template wording (sources: Meta error codes + MSG91 / ChatDaddy guides in WHATSAPP-PLAN.md)
const CONTENT_SUBCODES = {
  2388293: ["ratio", "too many blanks for the length of the message"],
  2388299: ["edge_variable", "the message starts or ends with a blank"],
  2388040: ["too_long", "a part of the message is too long"],
  2388019: ["too_long", "the message is too long"],
  2388047: ["format", "the message format is not allowed"],
  2388072: ["format", "the message format is not allowed"],
  2388073: ["format", "the message format is not allowed"],
};
// ONE template create / edit refusal -> what Helm does next and what the studio is told.
//   reason: ratio | edge_variable | too_long | format | exists | auth_not_eligible | rate_limit | token | permission | timeout | other
//   next:   failed (permanent - Fix and resubmit after the wording is fixed) | retry (wait and try again) | pause (Meta rate limit) | exists
export function templateError(status, body, category) {
  const e = (body && body.error) || {};
  const code = Number(e.code) || 0, sub = Number(e.error_subcode) || 0;
  const msg = String(e.error_user_msg || e.message || "");
  const auth = String(category || "").toUpperCase() === "AUTHENTICATION";
  if (code === 100 && (sub === 2388023 || sub === 2388024 || /already exists/i.test(msg))) return { reason: "exists", next: "exists", text: "already in your WhatsApp account" };
  if (CONTENT_SUBCODES[sub]) return { reason: CONTENT_SUBCODES[sub][0], next: "failed", text: CONTENT_SUBCODES[sub][1] };
  if (code === 4 || code === 80008 || code === 80007 || code === 130429 || status === 429) return { reason: "rate_limit", next: "pause", text: "Meta is limiting template changes for a while - Helm waits and tries again by itself" };
  if (status === 401 || code === 190) return { reason: "token", next: "retry", text: "the access token stopped working - paste a new permanent token" };
  // authentication (approval code) templates need a verified business / a high enough messaging limit
  if (auth && (code === 10 || code === 200 || code === 368 || code === 131031 || status === 403 || /permission|eligib|verif|not allowed|limit/i.test(msg))) {
    return { reason: "auth_not_eligible", next: "failed", text: "Meta allows approval-code templates only for a verified business" };
  }
  if (code === 10 || code === 200 || (code > 200 && code <= 299) || status === 403) return { reason: "permission", next: "retry", text: "the token is missing the whatsapp_business_management permission" };
  if (code === 100 || code === 192) return { reason: "format", next: "failed", text: "Meta did not accept the template (" + (sub || code) + ")" };
  if (status >= 500 || status === 0 || code === 1 || code === 2) return { reason: "other", next: "retry", text: "Meta had a temporary problem - Helm tries again by itself" };
  return { reason: "other", next: "retry", text: "Meta refused it (status " + (Number(status) || 0) + (code ? ", code " + code : "") + ")" };
}
// Meta's error kept per template: numbers + short text only - no links, no long token-like strings, one line
/** @returns {{ reason: string, status: number, code?: number, subcode?: number, title?: string, message?: string }} */
export function safeMetaError(status, body, reason) {
  const e = (body && body.error) || {};
  const clean = (v, n) => String(v || "").replace(/https?:\/\/\S+/gi, "[link]").replace(/[A-Za-z0-9_-]{32,}/g, "[hidden]").replace(/[\u0000-\u001f\u007f<>]+/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
  /** @type {{ reason: string, status: number, code?: number, subcode?: number, title?: string, message?: string }} */
  const out = { reason: /^[a-z_]{1,30}$/.test(String(reason || "")) ? String(reason) : "other", status: Number(status) || 0 };
  if (Number(e.code)) out.code = Number(e.code);
  if (Number(e.error_subcode)) out.subcode = Number(e.error_subcode);
  const title = clean(e.error_user_title, 120), message = clean(e.error_user_msg || e.message, 300);
  if (title) out.title = title;
  if (message) out.message = message;
  return out;
}
// what the studio reads for a template (job row from my_wa_template_setup)
export const REASON_TEXT = {
  ratio: "Meta said the message has too many blanks for its length. Helm's wording is fixed - press Fix and resubmit.",
  edge_variable: "Meta said the message starts or ends with a blank. Press Fix and resubmit.",
  too_long: "Meta said the message is too long. Press Fix and resubmit.",
  format: "Meta did not accept the template format. Press Fix and resubmit.",
  auth_not_eligible: "Verify your business in Meta Business Manager - approval codes go by e-mail meanwhile.",
  rate_limit: "Meta is limiting template changes for a while. Helm waits and tries again by itself.",
  token: "The access token stopped working. Paste a new permanent token, then press Check connection.",
  permission: "The token is missing the whatsapp_business_management permission. Make a new token with it.",
  other: "Meta refused it. Helm tries again by itself; if it stays like this press Fix and resubmit.",
};

// the template list read from Meta -> Helm templates only, with the review facts
export const TEMPLATE_FIELDS = "name,status,language,category,rejected_reason,quality_score,id";
export function templateDetails(list) {
  const out = [];
  for (const t of Array.isArray(list) ? list : []) {
    const name = String((t && t.name) || ""), lang = String((t && t.language) || "");
    if (!CATALOGUE_NAMES.includes(name) || lang !== STUDIO_LANG) continue;
    const up = (v, n) => { const x = String(v || "").toUpperCase(); return new RegExp("^[A-Z_]{1," + n + "}$").test(x) ? x : null; };
    const q = t.quality_score && typeof t.quality_score === "object" ? t.quality_score.score : t.quality_score;
    out.push({ name, language: lang, status: up(t.status, 30) || "PENDING", category: up(t.category, 30), quality_score: up(q, 20),
      rejected_reason: up(t.rejected_reason, 60), id: /^[0-9]{1,30}$/.test(String(t.id || "")) ? String(t.id) : null });
  }
  return out;
}

// ---- Meta Template Library ------------------------------------------------------------------------------------------
// Docs (checked 12 Nov 2026):
//   https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-library
//   https://developers.facebook.com/docs/graph-api/reference/whats-app-business-account/message_templates/
// Create: POST /<WABA_ID>/message_templates { name, language, category, library_template_name,
//   library_template_body_inputs (add_contact_number, add_learn_more_link, add_security_recommendation,
//   add_track_package_link, code_expiration_minutes), library_template_button_inputs [{ type, url: { base_url,
//   url_suffix_example }, otp_type, ... }] }. Library content is fixed (only the blanks are filled); utility for the
//   payment ones. Browse: GET /message_template_library?usecase=...&topic=...&search=...&language=... -> name, body,
//   body_params, body_param_types (TEXT AMOUNT DATE ...), buttons. Meta does NOT publish a stable list of names, so Helm
//   looks the entry up each time and uses it only when every blank maps to a field Helm has; otherwise Helm's own wording.
// Which Helm templates may come from the library (the sender fills either version from the stored param_map):
//   proposal_approval_otp  authentication copy-code (same send payload either way)
//   proposal_approved_pay  payment due / pay now
//   payment_received       payment received
// Not from the library: helm_event_reminder / helm_notice / helm_task_assigned (their senders have only ONE free-text
// line, a library entry needs separate fields) and the proposal / crew / vendor / run-sheet ones (no library entry).
/** @type {Record<string, { category: string, query: Record<string, string>, auth?: boolean, need?: string[] }>} */
export const LIBRARY = {
  proposal_approval_otp: { category: "AUTHENTICATION", query: { search: "verification code" }, auth: true },
  proposal_approved_pay: { category: "UTILITY", query: { topic: "PAYMENTS", usecase: "PAYMENT_DUE_REMINDER" }, need: ["amount"] },
  payment_received: { category: "UTILITY", query: { topic: "PAYMENTS", usecase: "PAYMENT_CONFIRMATION" }, need: ["amount"] },
};
// the library query path (relative to the Graph version)
export function libraryQuery(name) {
  const spec = LIBRARY[name];
  if (!spec) return null;
  const q = new URLSearchParams({ ...spec.query, limit: "25" });
  return "message_template_library?" + q.toString();
}
// the Helm field a library blank stands for, from its type and the words just before it (null = unknown -> not used)
function fieldOfBlank(before, type, index) {
  const b = String(before || "").toLowerCase().replace(/\s+/g, " ").slice(-40);
  const ty = String(type || "TEXT").toUpperCase();
  if (ty === "AMOUNT" || /(amount|payment of|total|sum|inr|rs\.?|\u20b9)\s*$/.test(b)) return "amount";
  if (ty === "DATE") return "date";
  if (index === 1 && /^(hi|hello|dear|hey)[ ,]*$/.test(b.trim())) return "name";
  if (/(order|invoice|booking|reference|ref\.?|bill|account|number|no\.?|#)\s*$/.test(b)) return "reference";
  if (/(from|with|to|at)\s*$/.test(b) && ty === "TEXT") return "business";
  return null;
}
// a library entry -> { library_name, fields: [helm field per {{n}}], url_button } or null when it does not fit
export function libraryFit(name, entry, appUrl) {
  const spec = LIBRARY[name];
  if (!spec || !entry || typeof entry !== "object") return null;
  const lname = String(entry.name || "");
  if (!/^[a-z0-9_]{1,128}$/.test(lname)) return null;
  const cat = String(entry.category || "").toUpperCase();
  if (cat && cat !== spec.category) return null;
  const buttons = Array.isArray(entry.buttons) ? entry.buttons : [];
  if (spec.auth) {
    if (buttons.some((b) => b && b.type && !/^(OTP|COPY_CODE)$/i.test(String(b.type)))) return null;
    return { library_name: lname, fields: ["code"], url_button: false, auth: true };
  }
  const body = String(entry.body || "");
  const types = Array.isArray(entry.body_param_types) ? entry.body_param_types : [];
  const blanks = [...body.matchAll(VAR)];
  if (!blanks.length || blanks.length > 6) return null;
  const fields = [];
  let last = 0;
  for (let i = 0; i < blanks.length; i++) {
    const m = blanks[i];
    if (Number(m[1]) !== i + 1) return null;
    const f = fieldOfBlank(body.slice(last, m.index), types[i], i + 1);
    if (!f || fields.includes(f)) return null;
    fields.push(f); last = m.index + m[0].length;
  }
  for (const n of spec.need || []) if (!fields.includes(n)) return null;
  // buttons: none, or exactly one link (Helm's portal link with the client's token), anything else does not fit
  if (buttons.length > 1) return null;
  const url = buttons.length === 1 && String(buttons[0].type || "").toUpperCase() === "URL";
  if (buttons.length === 1 && !url) return null;
  return { library_name: lname, fields, url_button: url };
}
// the Meta create body for a library version (fit from libraryFit)
export function libraryCreateBody(name, fit, appUrl) {
  const spec = LIBRARY[name];
  if (!spec || !fit) return null;
  const o = siteOrigin(appUrl);
  const b = { name, language: STUDIO_LANG, category: spec.category, library_template_name: fit.library_name };
  if (spec.auth) {
    b.library_template_body_inputs = { add_security_recommendation: true, code_expiration_minutes: 10 };
    b.library_template_button_inputs = [{ type: "OTP", otp_type: "COPY_CODE" }];
    b.message_send_ttl_seconds = 600;
  } else if (fit.url_button) {
    b.library_template_button_inputs = [{ type: "URL", url: { base_url: o + "/portal.html?token={{1}}", url_suffix_example: o + "/portal.html?token=" + SAMPLE_TOKEN } }];
  }
  return b;
}
// R156: which variant a studio created (wa_template_variant) -> the body parameters to send.
// values: { name, amount, date, reference, business } filled by the sender. Own wording -> null (the sender keeps its order).
export function libraryParams(variant, values) {
  if (!variant || variant.variant !== "library" || !variant.param_map || !Array.isArray(variant.param_map.fields)) return null;
  const v = values || {};
  const clip = (x) => String(x == null ? "" : x).replace(/[\r\n\t]+/g, " ").replace(/ {4,}/g, "   ").trim().slice(0, 120) || "-";
  const fields = variant.param_map.fields.filter((f) => /^[a-z]{1,20}$/.test(String(f)));
  if (fields.length !== variant.param_map.fields.length || fields.includes("code")) return null;
  return { params: fields.map((f) => clip(v[f])), urlButton: variant.param_map.url_button === true };
}

// ---- number health (read-only Meta facts) ------------------------------------------------------------------------------
// phone: GET /<PHONE_ID>?fields=quality_rating,status,name_status,throughput (+ messaging_limit_tier, health_status when
// Meta answers them). Docs: https://developers.facebook.com/docs/whatsapp/cloud-api/health-status and
// https://developers.facebook.com/documentation/business-messaging/whatsapp/messaging-limits
const LOW_TIERS = /^(TIER_50|TIER_250)$/;
export function healthOf(phone, tierAns, healthAns) {
  const p = phone && typeof phone === "object" ? phone : {};
  const up = (v, n) => { const x = String(v || "").toUpperCase(); return new RegExp("^[A-Z0-9_]{1," + n + "}$").test(x) ? x : null; };
  const quality = up(p.quality_rating, 20);
  const tier = up((tierAns && tierAns.messaging_limit_tier) || p.messaging_limit_tier, 30);
  const hs = (healthAns && healthAns.health_status) || p.health_status || null;
  const canSend = up(hs && hs.can_send_message, 20);
  const errors = [];
  let payment = false;
  for (const ent of hs && Array.isArray(hs.entities) ? hs.entities : []) {
    for (const er of Array.isArray(ent && ent.errors) ? ent.errors : []) {
      const d = String((er && er.error_description) || "");
      if (/payment|billing|credit line|funding/i.test(d) || Number(er && er.error_code) === 131042) payment = true;
      if (d) errors.push(d.replace(/https?:\/\/\S+/g, "[link]").slice(0, 160));
    }
  }
  const limitLow = !!(tier && LOW_TIERS.test(tier));
  const warnings = [];
  if (quality === "RED") warnings.push("quality_red"); else if (quality === "YELLOW") warnings.push("quality_yellow");
  if (payment) warnings.push("payment");
  if (limitLow) warnings.push("limit_low");
  if (canSend === "BLOCKED") warnings.push("blocked");
  return { quality, tier, can_send: canSend, name_status: up(p.name_status, 30), payment_issue: payment, limit_low: limitLow, errors: errors.slice(0, 5), warnings };
}
