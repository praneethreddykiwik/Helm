// cantwork-email.mjs - R187 (0370): the day-off request e-mails. Pure (no I/O); shared by comms-dispatch (Deno) and the
// node tests. One claimed cantwork_email_outbox row (cantwork_email_claim) -> { subject, text } and a designed HTML part on
// the shared Helm layout (_shared/email-layout.mjs).
//   * request   to the owner / admins / managers / Staff editors: "<worker> asked for <day> off" + the Staff page link
//   * decision  to the staff member: "Your day off on <day> is approved" / "... was not approved" + the office's note and
//               their permanent link (work.html?staff=<64 hex>), where they tap "OK, got it"
// Links: APP_URL + the row's own path only (staff.html#cantwork-requests or work.html?staff=<64 hex>); the host never comes
// from the database. Anything unexpected -> empty text and comms-dispatch marks the row skipped.
// Free trial: nothing is queued (in-app only) and the claim re-checks it.
import * as L from "../_shared/email-layout.mjs";

export const CANTWORK_OFFICE_REASON = "you approve days off for this studio in Helm";
export const CANTWORK_STAFF_REASON = "you are on the staff list of this studio and asked for a day off";
export const CANTWORK_KINDS = ["request", "decision"];

const ORIGIN = /^https:\/\/[A-Za-z0-9.-]{1,190}(?::[0-9]{1,5})?$/;
const PATH = /^(?:staff\.html#cantwork-requests|work\.html\?staff=[0-9a-f]{64})$/;
const DAY = /^[0-9]{2}\/[0-9]{2}\/[0-9]{4}$/;
const clip = (v, n) => String(v == null ? "" : v).replace(/[\r\n\t<>]+/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const e = L.escHtml;

export function cantworkLink(row, origin) {
  const o = String(origin || "").replace(/\/+$/, "");
  const p = String((row && row.link_path) || "");
  if (!ORIGIN.test(o) || !PATH.test(p)) return "";
  if (String(row.kind) === "request" && !p.startsWith("staff.html")) return "";
  if (String(row.kind) === "decision" && !p.startsWith("work.html")) return "";
  return o + "/" + p;
}
function first(name) { return clip(name, 80).split(" ")[0] || ""; }
function dayOf(row) {
  const d = clip(row && row.day, 10);
  if (!DAY.test(d)) return "";
  const w = clip(row && row.weekday, 4);
  return (/^[A-Za-z]{2,4}$/.test(w) ? w + " " : "") + d;
}

// { subject, text } for one claimed row; "" text = do not send
export function cantworkMessage(row, origin) {
  const none = { subject: "", text: "" };
  if (!row || !CANTWORK_KINDS.includes(String(row.kind))) return none;
  const day = dayOf(row);
  if (!day) return none;
  const studio = clip(row.studio, 80) || "your studio";
  const hi = "Hello" + (first(row.name) ? " " + first(row.name) : "") + ",\n\n";
  const link = cantworkLink(row, origin);
  const sign = "\n\nThank you,\n" + studio;
  if (String(row.kind) === "request") {
    const worker = clip(row.worker, 80) || "A staff member";
    const reason = clip(row.note, 200);
    return {
      subject: worker + " asked for " + day + " off",
      text: hi + worker + " asked for a day off on " + day + "." + (reason ? "\nReason: " + reason : "\n(No reason given.)") +
        "\n\nPlease approve or turn it down in Helm" + (link ? ":\n" + link : " (Staff page -> Day-off requests).") +
        "\n\nUntil you decide, Helm shows a warning if someone gives them work that day." + "\n\n-- Helm, for " + studio,
    };
  }
  const ok = String(row.approval) === "approved";
  if (!ok && String(row.approval) !== "rejected") return none;
  const note = clip(row.decision_note, 200), by = clip(row.decided_by, 80);
  return {
    subject: (ok ? "Day off approved: " : "Day off not approved: ") + day,
    text: hi + studio + (ok ? " approved your day off on " + day + ". You don't need to work that day."
                            : " could not approve your day off on " + day + ". Please plan to work that day - call your manager if you can't.") +
      (note ? "\n\nNote" + (by ? " from " + by : "") + ": " + note : "") +
      (link ? "\n\nOpen your page to see it and tap \"OK, got it\":\n" + link : "") + sign,
  };
}

// the designed HTML part ("" when the text is empty - same rule)
export function cantworkHtml(row, origin, opts = {}) {
  const msg = cantworkMessage(row, origin);
  if (!msg.text) return "";
  const studio = clip(row.studio, 80) || "your studio";
  const name = first(row.name);
  const day = dayOf(row);
  const link = cantworkLink(row, origin);
  const site = /^https:\/\/[A-Za-z0-9.-]{1,190}(?::[0-9]{1,5})?$/.test(String(origin || "").replace(/\/+$/, "")) ? String(origin).replace(/\/+$/, "") : L.SITE;
  const hello = L.para("Hello" + (name ? " " + L.strong(e(name)) : "") + ",", "0 0 14px");
  const cta = (label) => link ? L.button(e(link), e(label)) + L.fallback(e(link)) : "";
  if (String(row.kind) === "request") {
    const worker = clip(row.worker, 80) || "A staff member";
    const reason = clip(row.note, 200);
    const inner = L.h1(e("Day-off request")) + hello +
      L.para(L.strong(e(worker)) + " asked for a day off.") +
      L.facts([[e("Who"), e(worker)], [e("Day"), e(day)], [e("Reason"), e(reason || "No reason given")]]) +
      cta("Approve or turn down") +
      L.note("Until you decide, Helm warns anyone who gives " + e(worker) + " work that day. Helm, for " + L.strong(e(studio)) + ".");
    return L.layout(msg.subject, worker + " asked for " + day + " off", inner, { site, reason: CANTWORK_OFFICE_REASON, address: opts.address, sub: "" });
  }
  const ok = String(row.approval) === "approved";
  const note = clip(row.decision_note, 200), by = clip(row.decided_by, 80);
  const inner = L.h1(e(ok ? "Day off approved" : "Day off not approved")) + hello +
    L.para(L.strong(e(studio)) + (ok ? " approved your day off on " + L.strong(e(day)) + ". You don't need to work that day."
                                      : " could not approve your day off on " + L.strong(e(day)) + ". Please plan to work that day &mdash; call your manager if you can't.")) +
    (note ? L.facts([[e(by ? "Note from " + by : "Note"), e(note)]]) : "") +
    cta("Open my page") + (link ? L.para("Tap &ldquo;OK, got it&rdquo; there so the office knows you saw it.", "0 0 20px") : "") +
    L.note(`Questions? Just reply to this e-mail &mdash; it goes to ${L.strong(e(studio))}.`);
  return L.layout(msg.subject, (ok ? "Approved: " : "Not approved: ") + day, inner, { site, reason: CANTWORK_STAFF_REASON, address: opts.address, sub: "" });
}
