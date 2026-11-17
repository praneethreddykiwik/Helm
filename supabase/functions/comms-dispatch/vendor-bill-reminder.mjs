// vendor-bill-reminder.mjs - R190 (migration 0373): the e-mail for one claimed vendor bill reminder
// (vendor_bill_reminder_claim). Pure (no I/O); shared by comms-dispatch (Deno) and the node tests.
//   * audience office (the studio's "who pays vendors" people): kinds before / due / overdue
//       "Vendor bill due in 3 days: Rs 18,000 to Sri Sai Tents" + bill facts + a link to the event's Settlement page
//       (APP_URL + "/settlement.html?quote=<event id>#vendorBills" - the host never comes from the database)
//   * audience vendor (only when the studio turned it on): kind vendor_before
//       "Your bill #142 is due for payment on 20/12/2026" - no link, no other money than the vendor's own bill
// Every dynamic value is clipped (text) and HTML-escaped (html). Anything unexpected -> empty text, and comms-dispatch then
// marks the row skipped (fails closed). Crew never get these e-mails (the claim only gives office payers / the vendor).
import * as L from "../_shared/email-layout.mjs";

export const VENDOR_BILL_TX_REASON = "your studio chose you to pay its vendor bills on Helm";
export const VENDOR_BILL_VENDOR_TX_REASON = "a studio on Helm has a bill of yours to pay";
export const VENDOR_BILL_KINDS = ["before", "due", "overdue", "vendor_before"];

const ORIGIN = /^https:\/\/[A-Za-z0-9.-]{1,190}(?::[0-9]{1,5})?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATE = /^[0-9]{2}\/[0-9]{2}\/[0-9]{4}$/;
const CUR = /^[A-Z]{3}$/;
const clip = (v, n) => String(v == null ? "" : v).replace(/[\r\n\t<>]+/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const e = (v) => L.escHtml(v);

// "Rs 18,000" / "Rs 1,250.50" / "AED 1,250" (Indian grouping for INR)
export function billMoney(n, cur) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return "";
  const c = CUR.test(String(cur || "")) ? String(cur) : "INR";
  const whole = Math.abs(v - Math.round(v)) < 0.005;
  const s = v.toLocaleString(c === "INR" ? "en-IN" : "en-US", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 });
  return (c === "INR" ? "Rs " : c + " ") + s;
}

// the office link: the event's Settlement page at the Vendor bills card
export function billLink(row, origin) {
  const o = String(origin || "").replace(/\/+$/, "");
  if (!ORIGIN.test(o) || !row || !UUID_RE.test(String(row.quote_id || ""))) return "";
  return o + "/settlement.html?quote=" + row.quote_id + "#vendorBills";
}

function whenLine(kind, days) {
  const d = Math.round(Number(days));
  if (kind === "due") return "due today";
  if (kind === "overdue") return Number.isFinite(d) && d < 0 ? "overdue by " + -d + (d === -1 ? " day" : " days") : "overdue";
  return Number.isFinite(d) && d > 0 ? "due in " + d + (d === 1 ? " day" : " days") : "due soon";
}

// { subject, text } for one claimed row; "" text = do not send
export function vendorBillMessage(row, origin) {
  if (!row || typeof row !== "object" || !VENDOR_BILL_KINDS.includes(String(row.kind))) return { subject: "", text: "" };
  const kind = String(row.kind), audience = String(row.audience || "");
  const studio = clip(row.studio, 80) || "your studio", event = clip(row.event, 120) || "the event";
  const vendor = clip(row.vendor, 120), billNo = clip(row.bill_no, 40), due = clip(row.due_text, 12);
  const date = clip(row.event_date, 12), name = clip(row.name, 80).split(" ")[0] || "";
  const open = billMoney(row.open, row.currency), total = billMoney(row.amount, row.currency);
  if (!open || !DATE.test(due)) return { subject: "", text: "" };
  const billRef = billNo ? "bill #" + billNo : "bill";
  const evLine = event + (DATE.test(date) ? " (" + date + ")" : "");
  if (audience === "vendor") {
    if (kind !== "vendor_before") return { subject: "", text: "" };
    return {
      subject: "Your " + billRef + " from " + studio + " is due for payment on " + due,
      text: "Hello" + (vendor ? " " + vendor : "") + ",\n\n" +
        "This is a note from " + studio + ": your " + billRef + " for " + evLine + " is due for payment on " + due + ".\n" +
        "Amount still to be paid: " + open + (total && total !== open ? " (bill total " + total + ")" : "") + ".\n\n" +
        "If anything on the bill is wrong, or the payment details changed, please reply to this e-mail.\n\n" +
        "Thank you,\n" + studio,
    };
  }
  if (audience !== "office" || kind === "vendor_before") return { subject: "", text: "" };
  const link = billLink(row, origin);
  if (!link) return { subject: "", text: "" };
  const w = whenLine(kind, row.days);
  const head = (kind === "overdue" ? "Overdue: " : kind === "due" ? "Due today: " : "Due soon: ") + "vendor bill " + open + " to " + (vendor || "a vendor");
  return {
    subject: head + " - " + event,
    text: "Hello" + (name ? " " + name : "") + ",\n\n" +
      "A vendor bill is " + w + ": " + open + " to " + (vendor || "a vendor") + " (" + billRef + ", due " + due + ") for " + evLine + "." +
      (total && total !== open ? "\nBill total " + total + "; " + open + " is still to be paid." : "") + "\n\n" +
      "Record the payment (with TDS if you deduct it) on the event's Settlement page:\n" + link + "\n\n" +
      "You get this because you pay vendor bills for " + studio + ". An admin can change who gets these on the Business page (Vendor bill reminders).\n\n" +
      "Helm, for " + studio,
  };
}

const TONE = { soon: ["#fff4e0", "#8a5a00"], late: ["#fdecec", "#b42318"], info: [L.C.brandSoft, L.C.brand] };
const chip = (text, tone) => {
  const [bg, fg] = TONE[tone] || TONE.info;
  return `<span style="display:inline-block;background:${bg};color:${fg};font-family:${L.FONT};font-size:13px;line-height:18px;font-weight:700;border-radius:999px;padding:5px 12px;">${e(text)}</span>`;
};
const eyebrow = (studio) =>
  `<tr><td style="padding:0 0 14px;"><span class="codebox" style="display:inline-block;background:${L.C.brandSoft};color:${L.C.brand};font-family:${L.FONT};font-size:12px;line-height:16px;font-weight:700;letter-spacing:.04em;border-radius:999px;padding:5px 12px;">${e(studio)} via Helm</span></td></tr>`;
const hero = (amount, chipText, tone) =>
  `<tr><td style="padding:2px 0 22px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td class="ink" valign="middle" style="font-family:${L.FONT};font-size:34px;line-height:40px;font-weight:700;letter-spacing:-.02em;color:${L.C.ink};padding-right:14px;">${e(amount)}</td>
<td valign="middle">${chip(chipText, tone)}</td></tr></table></td></tr>`;
const facts = (rows) => L.facts(rows.filter(([, v]) => v).map(([k, v]) => [e(k), e(v)]));

// the designed HTML part on the shared Helm layout ("" when the text is empty - same rule)
export function vendorBillHtml(row, origin, opts = {}) {
  const msg = vendorBillMessage(row, origin);
  if (!msg.text) return "";
  const kind = String(row.kind), vendorSide = String(row.audience) === "vendor";
  const studio = clip(row.studio, 80) || "your studio", event = clip(row.event, 120) || "the event";
  const vendor = clip(row.vendor, 120), billNo = clip(row.bill_no, 40), due = clip(row.due_text, 12), date = clip(row.event_date, 12);
  const open = billMoney(row.open, row.currency), total = billMoney(row.amount, row.currency);
  const name = vendorSide ? vendor : (clip(row.name, 80).split(" ")[0] || "");
  const site = String(origin || "").replace(/\/+$/, "");
  const lay = { site: ORIGIN.test(site) ? site : L.SITE, address: opts.address, sub: "" };
  const hello = L.para("Hello" + (name ? " " + L.strong(e(name)) : "") + ",", "0 0 14px");
  const rows = [["Vendor", vendorSide ? "" : vendor], ["Bill", billNo ? "#" + billNo : ""], ["Due", due],
    ["Still to pay", open], ["Bill total", total && total !== open ? total : ""], ["Event", event], ["Event date", DATE.test(date) ? date : ""]];
  if (vendorSide) {
    const inner = eyebrow(studio) + L.h1("Your bill is due for payment") + hello +
      L.para(L.strong(e(studio)) + " has your " + e(billNo ? "bill #" + billNo : "bill") + " for " + L.strong(e(event)) + " due for payment on " + L.strong(e(due)) + ".") +
      facts(rows) + L.para("If anything on the bill is wrong, or your payment details changed, just reply to this e-mail.") +
      L.note(`Sent by ${L.strong(e(studio))} with Helm.`);
    return L.layout(msg.subject, "Bill due for payment on " + due, inner, { ...lay, reason: VENDOR_BILL_VENDOR_TX_REASON });
  }
  const link = billLink(row, origin);
  const w = whenLine(kind, row.days);
  const tone = kind === "overdue" ? "late" : kind === "due" ? "late" : "soon";
  const inner = eyebrow(studio) + L.h1(e(kind === "overdue" ? "Vendor bill overdue" : kind === "due" ? "Vendor bill due today" : "Vendor bill due soon")) + hello +
    hero(open, w.charAt(0).toUpperCase() + w.slice(1), tone) +
    facts(rows) +
    L.button(e(link), "Record the payment") + L.fallback(e(link)) +
    L.para("Record TDS in the same box if you deduct it - the bill then counts as fully paid.") +
    L.note(`You get this because you pay vendor bills for ${L.strong(e(studio))}. An admin can change who gets these on the Business page (Vendor bill reminders).`);
  return L.layout(msg.subject, w + ": " + open + " to " + (vendor || "a vendor"), inner, { ...lay, reason: VENDOR_BILL_TX_REASON });
}
