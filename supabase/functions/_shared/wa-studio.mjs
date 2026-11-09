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
      "Hi {{1}}, {{2}} has shared your proposal for your {{3}} on {{4}}. Total: {{5}}. Tap below to review and approve it. Reply STOP to opt out.",
      ["Priya", "Aurora Events", "Wedding", "12 Dec 2026", "INR 2,36,000"], urlButton("Review proposal", o)),
    utility("proposal_reminder",
      "Hi {{1}}, a reminder from {{2}}: your proposal for your {{3}} on {{4}} (total {{5}}) is waiting for your approval. Reply STOP to opt out.",
      ["Priya", "Aurora Events", "Wedding", "12 Dec 2026", "INR 2,36,000"], urlButton("Review proposal", o)),
    utility("proposal_approved_pay",
      "Thank you {{1}}, your {{2}} on {{3}} is approved. Amount: {{4}}. Tap below to view your booking and pay securely.",
      ["Priya", "Wedding", "12 Dec 2026", "INR 2,36,000"], urlButton("Pay now", o)),
    utility("payment_received",
      "Hi {{1}}, {{2}} has received your payment for your {{3}}. Thank you! Tap below to see your receipt and booking.",
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
    utility("staff_task_assigned", "Hi {{1}}, you have a new task: {{2}} for {{3}} on {{4}} at {{5}}, {{6}}. Open your task link to accept or decline it: {{7}} Thank you.",
      ["Ravi", "Stage lights", "Rao Wedding", "12 Dec 2026", "12:30 PM", "Grand Convention Centre", L]),
    utility("staff_task_reminder", "Hi {{1}}, reminder: {{2}} for {{3}} starts at {{4}}, in {{5}} minutes. Your task link: {{6}} Please be on time.",
      ["Ravi", "Stage lights", "Rao Wedding", "12:30 PM", "10", L]),
    utility("staff_task_overdue", "Hi {{1}}, {{2}} for {{3}} was due at {{4}} and has not started yet. Please start it or tell the office from your link: {{5}} Thank you.",
      ["Ravi", "Stage lights", "Rao Wedding", "12:30 PM", L]),
    utility("staff_task_changed", "Hi {{1}}, your task {{2}} for {{3}} has changed: {{4}}. Please check your task link for the details.",
      ["Ravi", "Stage lights", "Rao Wedding", "the start time moved to 1:00 PM"]),
    utility("staff_open_shift", "Hi {{1}}, an open shift is available: {{2}} for {{3}} on {{4}}, {{5}} to {{6}}, at {{7}}. Take it from your link: {{8}} First come, first served.",
      ["Ravi", "Decoration", "Rao Wedding", "12 Dec 2026", "10:00 AM", "6:00 PM", "Grand Convention Centre", L]),
    utility("staff_shift_result", "Hi {{1}}, your request for the {{2}} shift at {{3}} on {{4}}: {{5}}. Details: {{6}} Thank you.",
      ["Ravi", "Decoration", "Rao Wedding", "12 Dec 2026", "confirmed", L]),
    utility("staff_leave_result", "Hi {{1}}, your request to be off on {{2}} was {{3}}. Note from the office: {{4}}. Thank you.",
      ["Ravi", "12 Dec 2026", "approved", "enjoy the family function"]),
    utility("office_staff_alert", "Staff alert: {{1}}, {{2}}. Task: {{3}} for {{4}} on {{5}}. Reason: {{6}}. Open the event to act on it: {{7}} Thank you.",
      ["Ravi Kumar", "task not started", "Stage lights", "Rao Wedding", "12 Dec 2026 12:30 PM", "no start after 3 reminders", o + "/ops.html?quote=" + SAMPLE_TOKEN]),
    utility("vendor_request", "Hello {{1}}, {{2}} would like to book you for {{3}} at {{4}} on {{5}}, {{6}}, at {{7}}. Amount: {{8}}. Please reply by {{9}} here: {{10}} Thank you.",
      ["Sri Flowers", "Aurora Events", "stage flowers", "Rao Wedding", "12 Dec 2026", "10:00 AM", "Grand Convention Centre", "INR 25,000", "8 Dec 2026", o + "/vendor-request.html?token=" + SAMPLE_TOKEN]),
    utility("vendor_follow_up", "Hello {{1}}, a reminder about {{2}} for {{3}}. Please reply by {{4}} here: {{5}} Thank you.",
      ["Sri Flowers", "stage flowers", "Rao Wedding", "8 Dec 2026", o + "/vendor-request.html?token=" + SAMPLE_TOKEN]),
    utility("vendor_delivery_reminder", "Hello {{1}}, reminder: {{2}} for {{3}} on {{4}} at {{5}}, {{6}}. Details: {{7}} Thank you.",
      ["Sri Flowers", "stage flowers", "Rao Wedding", "12 Dec 2026", "10:00 AM", "Grand Convention Centre", o + "/vendor-request.html?token=" + SAMPLE_TOKEN]),
    utility("vendor_invoice_update", "Hello {{1}}, your invoice {{2}} for {{3}} was {{4}}. Note: {{5}}. Details: {{6}} Thank you.",
      ["Sri Flowers", "INV-102", "INR 25,000", "approved", "paid on 15 Dec", o + "/vendor-request.html?token=" + SAMPLE_TOKEN]),
    utility("crew_runsheet_reminder", "Hi {{1}}, coming up at {{2}} for {{3}}: {{4}}. Your link: {{5}} Thank you.",
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
  if (code === 100 || code === 133010 || status === 404) return { kind: "number", text: "Meta does not know that phone number ID or account ID - check both numbers" };
  if (code === 132001 || code === 132000 || code === 132012 || code === 132015) return { kind: "template", text: "the message template is not approved yet in your WhatsApp account" };
  if (code === 131026 || code === 131021) return { kind: "recipient", text: "that number is not on WhatsApp" };
  if (code === 4 || code === 80007 || code === 130429 || code === 131048 || code === 131056 || status === 429) return { kind: "limit", text: "WhatsApp is limiting messages from this number - try again later" };
  return { kind: "other", text: "Meta refused it (status " + (Number(status) || 0) + (code ? ", code " + code : "") + ")" };
}

// connection check: Meta's phone-number answer + the account's numbers -> { ok, display, name, quality, error }
export function verifyResult(phoneId, phone, wabaPhones) {
  const id = String(phoneId || "");
  if (!phone || typeof phone !== "object" || String(phone.id || "") !== id) return { ok: false, error: "Meta did not return that phone number ID" };
  const list = Array.isArray(wabaPhones) ? wabaPhones : null;
  if (list && !list.some((p) => p && String(p.id || "") === id)) return { ok: false, error: "that phone number ID is not in the WhatsApp Business Account you entered" };
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
