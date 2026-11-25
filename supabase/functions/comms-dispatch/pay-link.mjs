// pay-link.mjs - R269 (owner, 26 Nov 2026: "add the link to pay here"): a payment reminder carries the client's own page, where they see their
// payments, pay, or say they have paid (0445). The link is the private client page the studio already shared (the approval link); a revoked,
// expired or cancelled one is never sent - the reminder then goes out as before. Pure: unit-tested in test/r262.test.mjs.
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// q = { approval_token, approval_token_expires_at, approval_token_revoked_at, status } -> the page, or ""
export function payPageUrl(origin, q, now = Date.now()) {
  if (!q || !UUID.test(String(q.approval_token || "")) || q.approval_token_revoked_at || q.status === "cancelled") return "";
  const exp = Date.parse(String(q.approval_token_expires_at || "")); if (isFinite(exp) && exp <= now) return "";
  const o = String(origin || "").replace(/\/+$/, ""); if (!/^https:\/\/[a-z0-9.-]+$/i.test(o)) return "";
  return o + "/portal.html?token=" + encodeURIComponent(String(q.approval_token).toLowerCase());
}
// the reminder with the link: text for e-mail and WhatsApp, and an e-mail body with a button
export function withPayLink(msg, url) {
  if (!url) return msg;
  const text = String(msg.text || "") + "\n\nSee your payments, pay, or tell us you have paid: " + url;
  const html = "<p>" + esc(msg.text).replace(/\n/g, "<br>") + "</p>"
    + '<p style="margin:20px 0"><a href="' + esc(url) + '" style="display:inline-block;padding:12px 22px;border-radius:10px;background:#e3f4ed;color:#065f46;font-weight:700;text-decoration:none">Open your payment page</a></p>'
    + '<p style="font-size:13px;color:#555">Or open this link: ' + esc(url) + "</p>";
  return { subject: msg.subject, text, html };
}
