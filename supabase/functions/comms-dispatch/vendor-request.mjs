// vendor-request.mjs - the e-mail for one claimed vendor request / reminder (migration 0256,
// vendor_request_claim with channel 'email'). Pure (no I/O); shared by comms-dispatch (Deno) and the node tests.
// Each row carries a fresh 64-hex link token minted by the claim (only its sha-256 is stored); the link is
// APP_URL + "/vendor-request?t=" + token - the host never comes from the database. Anything unexpected ->
// empty text, and comms-dispatch then marks the row skipped (fails closed). No money in the request e-mail.
// R259 (0447): a request row with a product list ("flow": 447) gets the list + one big button; vendorFlowMessage / vendorFlowHtml are the
// e-mails of vendor_flow_claim (change asked, booking confirmed with the agreed prices, please send your invoice). Rows of an older
// database (no "flow") read exactly as before.
import { plainDate } from "../_shared/plain-date.mjs";   // R243 (LOC-04): "20 Oct 2026", never a bare dd/mm/yyyy
import { billMoney } from "./vendor-bill-reminder.mjs";
import * as L from "../_shared/email-layout.mjs";
export const VENDOR_TOKEN = /^[0-9a-f]{64}$/;
export const VENDOR_TX_REASON = "a studio on Helm sent you a vendor request for an event";
const ORIGIN = /^https:\/\/[A-Za-z0-9.-]{1,190}(?::[0-9]{1,5})?$/;
const WHEN = /^[0-9]{2}\/[0-9]{2}\/[0-9]{4}, [0-9]{2}:[0-9]{2} [AP]M$/;
const DATE = /^[0-9]{2}\/[0-9]{2}\/[0-9]{4}$/;
const clip = (v, n) => String(v == null ? "" : v).replace(/[\r\n\t<>]+/g, " ").replace(/\s+/g, " ").trim().slice(0, n);

export function vendorRequestLink(row, origin) {
  const o = String(origin || "").replace(/\/+$/, "");
  if (!ORIGIN.test(o) || !row || !VENDOR_TOKEN.test(String(row.token || ""))) return "";
  return o + "/vendor-request?t=" + row.token;
}

// { subject, text } for one claimed row; "" text = do not send
export function vendorRequestMessage(row, origin) {
  if (!row || row.channel !== "email" || (row.kind !== "request" && row.kind !== "reminder")) return { subject: "", text: "" };
  const what = clip(row.what, 200), when = clip(row.when_text, 30), by = clip(row.respond_by_text, 30);
  const studio = clip(row.studio, 80) || "your event planner", event = clip(row.event, 120) || "the event";
  const date = clip(row.event_date, 12), who = clip(row.vendor_name, 120);
  const link = vendorRequestLink(row, origin);
  if (!what || !WHEN.test(when) || !link) return { subject: "", text: "" };
  const qty = Number(row.qty) > 0 ? " x" + Number(row.qty).toLocaleString("en-IN") : "";
  const item = what + qty, evLine = event + (DATE.test(date) ? " on " + plainDate(date) : "");
  const reply = WHEN.test(by) ? " Please reply by " + plainDate(by) + "." : "";
  const whenAt = plainDate(when);   // R243 (LOC-04)
  if (Number(row.flow) === 447) {
    const prods = products(row.lines), many = prods.length > 1, n = prods.length;
    const short = many ? n + " products" : item;
    return {
      subject: (row.kind === "reminder" ? "Reminder: " : "") + "Request from " + studio + ": " + short + " for " + event + " (" + whenAt + ")",
      text: "Hello" + (who ? " " + who : "") + ",\n\n" +
        studio + (row.kind === "reminder" ? " is still waiting for your answer" : " would like to book you") + " for " + evLine + ", needed " + whenAt + (clip(row.where_text, 200) ? " at " + clip(row.where_text, 200) : "") + ".\n\n" +
        (prods.length ? prods.map((p) => "- " + p.name + ": " + qtyText(p)).join("\n") : "- " + item) + "\n\n" +
        "Is it available? Open the link, choose Available or Not available" + (row.price_open ? " and tell us your price" : " and check the price") + ". You can attach your quotation (PDF or photo). No sign-in." + reply + "\n" + link + "\n\n" +
        "After the event you can send your invoice from the same link.\n\nThank you,\n" + studio,
    };
  }
  return {
    subject: (row.kind === "reminder" ? "Reminder: " : "") + "Request from " + studio + ": " + item + " for " + event + " (" + whenAt + ")",
    text: "Hello" + (who ? " " + who : "") + ",\n\n" +
      studio + (row.kind === "reminder" ? " is still waiting for your answer: " : " would like to book you: ") + item + " for " + evLine +
      ", needed " + whenAt + "." + reply + "\n\n" +
      "See the details and the agreed amount, then Accept or Decline - one tap, no sign-in:\n" + link + "\n\n" +
      "After the work you can send your tax invoice from the same link.\n\n" +
      "Thank you,\n" + studio,
  };
}

// ---- R259 (0447) ------------------------------------------------------------------------------------------------
export const VENDOR_FLOW_KINDS = ["change", "confirmed", "invoice_ask", "invoice_auto"];
const UNIT = /^[^<>\r\n]{0,20}$/;
// [{ name, qty, unit, price, total }] - anything odd is left out, at most 30
export function products(list) {
  return (Array.isArray(list) ? list : []).slice(0, 30).map((x) => {
    const qty = Number(x && x.qty), price = x && x.price != null ? Number(x.price) : null;
    return { name: clip(x && x.name, 120), qty, unit: UNIT.test(String((x && x.unit) || "")) ? clip(x && x.unit, 20) : "",
      price: price != null && Number.isFinite(price) && price >= 0 ? price : null };
  }).filter((x) => x.name && Number.isFinite(x.qty) && x.qty > 0);
}
const qtyText = (p) => p.qty.toLocaleString("en-IN") + (p.unit ? " " + p.unit : "");

function flowParts(row, origin) {
  if (!row || row.channel !== "email" || !VENDOR_FLOW_KINDS.includes(String(row.kind))) return null;
  const link = vendorRequestLink(row, origin);
  const c = row.confirmed && typeof row.confirmed === "object" ? row.confirmed : {};
  const prods = products(c.lines), cur = String(row.currency || "INR");
  const what = clip(row.what, 200), date = clip(row.event_date, 12), when = clip(row.when_text, 30);
  if (!link || !what) return null;
  return { link, prods, cur, what, kind: String(row.kind), studio: clip(row.studio, 80) || "your event planner", who: clip(row.vendor_name, 120),
    event: clip(row.event, 120) || "the event", date: DATE.test(date) ? plainDate(date) : "", when: WHEN.test(when) ? plainDate(when) : "", message: clip(row.message, 500),
    charges: Number(c.charges) > 0 ? Number(c.charges) : 0, discount: Number(c.discount) > 0 ? Number(c.discount) : 0, total: c.total != null && Number.isFinite(Number(c.total)) && Number(c.total) > 0 ? Number(c.total) : null };
}
const lineText = (f, p) => "- " + p.name + ": " + qtyText(p) + (p.price != null ? " x " + billMoney(p.price, f.cur) + " = " + billMoney(Math.round(p.qty * p.price * 100) / 100, f.cur) : "");
const listText = (f) => (f.prods.length ? f.prods.map((p) => lineText(f, p)).join("\n") : "- " + f.what) +
  (f.charges ? "\nDelivery / other charges: " + billMoney(f.charges, f.cur) : "") + (f.discount ? "\nDiscount: " + billMoney(f.discount, f.cur) : "") + (f.total != null ? "\nAgreed total: " + billMoney(f.total, f.cur) : "");

// { subject, text } of one claimed row; "" text = do not send
export function vendorFlowMessage(row, origin) {
  const f = flowParts(row, origin);
  if (!f) return { subject: "", text: "" };
  const hello = "Hello" + (f.who ? " " + f.who : "") + ",\n\n", ev = f.event + (f.date ? " on " + f.date : ""), bye = "\n\nThank you,\n" + f.studio;
  if (f.kind === "change") {
    if (!f.message) return { subject: "", text: "" };
    return { subject: f.studio + " asks: can you change your offer for " + ev + "?",
      text: hello + f.studio + " looked at your offer for " + ev + " and asks:\n\n\"" + f.message + "\"\n\nOpen the link to send a new offer. No sign-in.\n" + f.link + bye };
  }
  if (f.kind === "confirmed") {
    return { subject: "Booking confirmed: " + ev + " - " + f.studio,
      text: hello + f.studio + " confirmed your booking for " + ev + (f.when ? ", needed " + f.when : "") + ".\n\n" + listText(f) + "\n\nAll details are on your link. After the event you send your invoice there too.\n" + f.link + bye };
  }
  return { subject: "Please send your invoice: " + ev + " - " + f.studio,
    text: hello + "Thank you for your work at " + ev + ". Please send your invoice to " + f.studio + ".\n\n" + listText(f) +
      "\n\nOpen the link: your products and prices are already filled in. Add the invoice number and attach the invoice (PDF or photo). No sign-in.\n" + f.link +
      "\n\nAlready sent it? Then you can ignore this e-mail." + bye };
}

const th = (t, right) => `<td class="muted"${right ? ' align="right"' : ""} style="padding:10px 14px;font-family:${L.FONT};font-size:12px;line-height:16px;font-weight:700;color:${L.C.muted};">${t}</td>`;
const td = (t, right, bold) => `<td class="${bold ? "ink" : "body"} rule"${right ? ' align="right"' : ""} style="padding:10px 14px;border-top:1px solid ${L.C.rule};font-family:${L.FONT};font-size:14px;line-height:20px;color:${bold ? L.C.ink : L.C.body};${bold ? "font-weight:700;" : ""}">${t}</td>`;
function table(prods, cur, extra) {
  if (!prods.length) return "";
  const money = prods.some((p) => p.price != null);
  return `<tr><td style="padding:0 0 22px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="rule" style="border:1px solid ${L.C.rule};border-radius:12px;">` +
    `<tr>${th("Product")}${th("Quantity", true)}${money ? th("Price", true) + th("Total", true) : ""}</tr>` +
    prods.map((p) => `<tr>${td(L.escHtml(p.name))}${td(L.escHtml(qtyText(p)), true)}${money ? td(p.price != null ? L.escHtml(billMoney(p.price, cur)) : "", true) + td(p.price != null ? L.escHtml(billMoney(Math.round(p.qty * p.price * 100) / 100, cur)) : "", true) : ""}</tr>`).join("") +
    (extra || []).map(([k, v, b]) => `<tr>${td(L.escHtml(k), false, b)}${money ? `<td class="rule" colspan="2" style="border-top:1px solid ${L.C.rule};"></td>` : ""}${td(L.escHtml(v), true, b)}</tr>`).join("") + "</table></td></tr>";
}
const doc = (row, origin, opts, title, pre, inner, studio) => {
  const site = String(origin || "").replace(/\/+$/, "");
  return L.layout(title, pre, inner + L.note("From " + L.escHtml(studio) + " via Helm. The link is only for you; it opens this one request."), { site: ORIGIN.test(site) ? site : L.SITE, address: opts.address, reason: VENDOR_TX_REASON, sub: "" });
};

// the designed HTML part of a request / reminder with a product list ("" for a row of an older database: the plain layout as before)
export function vendorRequestHtml(row, origin, opts = {}) {
  const msg = vendorRequestMessage(row, origin);
  if (!msg.text || Number(row.flow) !== 447) return "";
  const e = L.escHtml, studio = clip(row.studio, 80) || "your event planner", event = clip(row.event, 120) || "the event", date = clip(row.event_date, 12), by = clip(row.respond_by_text, 30), link = vendorRequestLink(row, origin);
  const prods = products(row.lines), who = clip(row.vendor_name, 120);
  const inner = L.h1(row.kind === "reminder" ? e(studio) + " is waiting for your answer" : "Is it available?") +
    L.para("Hello" + (who ? " " + e(who) : "") + ", " + L.strong(e(studio)) + (row.kind === "reminder" ? " asked you for this and has not heard from you yet." : " would like to book you.")) +
    L.facts([["Event", e(event + (DATE.test(date) ? " on " + plainDate(date) : ""))], ["Needed", e(plainDate(clip(row.when_text, 30)))], ["Where", e(clip(row.where_text, 200))], ["Please reply by", WHEN.test(by) ? e(plainDate(by)) : ""]].filter((x) => x[1])) +
    table(prods, "INR") + L.button(e(link), row.price_open ? "Answer and tell your price" : "Answer the request") +
    L.para("Choose Available or Not available" + (row.price_open ? " and enter your price" : " and check the price") + ". You can attach your quotation (PDF or photo). No sign-in.") + L.fallback(e(link));
  return doc(row, origin, opts, msg.subject, studio + " needs your answer for " + event, inner, studio);
}

export function vendorFlowHtml(row, origin, opts = {}) {
  const msg = vendorFlowMessage(row, origin), f = flowParts(row, origin);
  if (!msg.text || !f) return "";
  const e = L.escHtml, ev = f.event + (f.date ? " on " + f.date : "");
  const extra = [f.charges ? ["Delivery / other charges", billMoney(f.charges, f.cur)] : null, f.discount ? ["Discount", "- " + billMoney(f.discount, f.cur)] : null, f.total != null ? ["Agreed total", billMoney(f.total, f.cur), true] : null].filter(Boolean);
  const hi = "Hello" + (f.who ? " " + e(f.who) : "") + ", ";
  let inner, label;
  if (f.kind === "change") {
    label = "Send a new offer";
    inner = L.h1("Can you change your offer?") + L.para(hi + L.strong(e(f.studio)) + " looked at your offer for " + e(ev) + " and asks:") + L.para("&ldquo;" + e(f.message) + "&rdquo;");
  } else if (f.kind === "confirmed") {
    label = "See the booking";
    inner = L.h1("Your booking is confirmed") + L.para(hi + L.strong(e(f.studio)) + " confirmed your booking for " + e(ev) + (f.when ? ", needed " + e(f.when) : "") + ".") + table(f.prods, f.cur, extra);
  } else {
    label = "Send your invoice";
    inner = L.h1("Please send your invoice") + L.para(hi + "thank you for your work at " + e(ev) + ". Please send your invoice to " + L.strong(e(f.studio)) + ".") + table(f.prods, f.cur, extra);
  }
  inner += L.button(e(f.link), label) + (f.kind === "invoice_ask" || f.kind === "invoice_auto" ? L.para("Your products and prices are already filled in. Add the invoice number and attach the invoice (PDF or photo). No sign-in. Already sent it? Then you can ignore this e-mail.") : "") + L.fallback(e(f.link));
  return doc(row, origin, opts, msg.subject, msg.subject, inner, f.studio);
}
