/* approve-plan.js - R255 (owner: after "Approved & consented" the client must see what happens next): the payment plan on the
   client's approval page (approve.html). Shown ABOVE the approve button, so the client approves knowing it, and again after the
   approval as "What happens next": the total, every payment with its name, percent, amount and date, the first open one marked
   "Pay now" / "Next payment", and how to pay (the studio's UPI ID and note - never a pay button; online payment is on hold).
   Reads only public_payment_schedule (BPStore.paySchedule.publicGet) with the page's own link token: this one event, the same
   rows the client portal and the booklet show. No answer / no rows = nothing is shown before the approval.
   DOM via createElement + textContent only (no HTML strings, no inline styles). model() is pure and unit-tested. */
(function (global) {
  "use strict";
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  // "Advance (25%)" already says it; an amount / a hand-made payment gets its share of the total
  function pctOf(label, amount, total) {
    var m = /\((\d+(?:\.\d+)?)%\)\s*$/.exec(String(label || "")); if (m) return m[1] + "%";
    if (!(total > 0) || !(amount > 0)) return "";
    return (Math.round(amount / total * 1000) / 10) + "%";
  }
  function nameOf(label) { return String(label || "Payment").replace(/\s*\(\d+(?:\.\d+)?%\)\s*$/, "").slice(0, 80) || "Payment"; }
  /* model(answer, approved) -> null | { total, paid, left, rows:[{name,pct,amount,paid,left,due,when,state,next,tag}], next, pay:{upi,note}|null }
     when: "date" (due is a day) | "approval" (counts from the approval that has not happened yet) | "open" (no date) */
  function model(s, approved) {
    if (!s || typeof s !== "object" || !Array.isArray(s.rows)) return null;
    var sum = 0; s.rows.forEach(function (r) { sum += num(r && r.amount); });
    var total = num(s.total) > 0 ? num(s.total) : sum, today = /^\d{4}-\d{2}-\d{2}$/.test(String(s.today || "")) ? String(s.today) : "", next = null;
    var rows = s.rows.filter(function (r) { return r && num(r.amount) > 0; }).slice(0, 20).map(function (r) {
      var due = /^\d{4}-\d{2}-\d{2}/.test(String(r.due_date || "")) ? String(r.due_date).slice(0, 10) : "";
      var o = { name: nameOf(r.label), pct: pctOf(r.label, num(r.amount), total), amount: num(r.amount), paid: num(r.paid), left: num(r.remaining), due: due,
        when: !approved && r.on_approval === true ? "approval" : due ? "date" : "open", state: r.state === "paid" ? "paid" : num(r.paid) > 0.005 ? "part" : "due", next: false, tag: "" };
      if (!next && o.state !== "paid") {
        o.next = true; o.toPay = o.left > 0 ? o.left : o.amount; next = o;
        o.tag = !approved ? "First payment" : !due || (today && due <= today) || r.state === "overdue" ? "Pay now" : "Next payment";
      } else if (o.state === "paid") o.tag = "Paid";
      return o;
    });
    var p = s.pay && typeof s.pay === "object" ? s.pay : null, upi = p && typeof p.upi === "string" ? p.upi.trim().slice(0, 120) : "", note = p && typeof p.note === "string" ? p.note.trim().slice(0, 600) : "";
    return { total: total, paid: num(s.paid), left: Math.max(0, Math.round((total - num(s.paid)) * 100) / 100), rows: rows, next: next, pay: upi || note ? { upi: upi, note: note } : null };
  }
  var api = { model: model, pctOf: pctOf, nameOf: nameOf };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.HelmApprovePlan = api;
  if (typeof document === "undefined") return;

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function dueText(r, fmt) {
    if (r.state === "paid") return "Paid";
    var d = r.when === "approval" ? "Due when you approve" : r.when === "date" ? "Due " + fmt(r.due) : "Your planner will confirm the date";
    return d;
  }
  // opts: { approved, money(n), date(iso), how (false = never show how to pay) } -> true when something was painted
  api.paint = function (box, m, opts) {
    while (box.firstChild) box.removeChild(box.firstChild);
    if (!m || !m.rows.length) return false;
    var money = opts.money, list = el("ol", "pp-list");
    if (opts.approved && m.next) {
      var hero = el("div", "pp-hero"); hero.appendChild(el("span", "pp-hero-l", (m.next.tag === "Pay now" ? "Pay now" : "Next payment") + ": " + m.next.name + (m.next.pct ? " (" + m.next.pct + ")" : "")));
      hero.appendChild(el("b", "pp-hero-a", money(m.next.toPay))); hero.appendChild(el("span", "pp-hero-d", dueText(m.next, opts.date))); box.appendChild(hero);
    }
    var tot = el("div", "pp-tot"); tot.appendChild(el("span", "", "Total")); tot.appendChild(el("b", "", money(m.total))); box.appendChild(tot);
    if (m.paid > 0.5) { var pd = el("div", "pp-tot pp-sub"); pd.appendChild(el("span", "", "Paid")); pd.appendChild(el("b", "", money(m.paid))); box.appendChild(pd); }
    m.rows.forEach(function (r) {
      var li = el("li", "pp-row" + (r.next ? " is-next" : "") + (r.state === "paid" ? " is-paid" : "")), g = el("span", "pp-g"), nm = el("b", "", r.name);
      if (r.pct) nm.appendChild(el("span", "pp-pct", " " + r.pct)); g.appendChild(nm);
      g.appendChild(el("span", "pp-due", dueText(r, opts.date) + (r.state === "part" ? ", " + money(r.left) + " left" : "")));
      var a = el("span", "pp-a"); a.appendChild(el("b", "", money(r.amount))); if (r.tag && r.tag !== "Paid") a.appendChild(el("span", "pp-tag", r.tag));
      li.appendChild(g); li.appendChild(a); list.appendChild(li);
    });
    box.appendChild(list);
    if (opts.approved && opts.how !== false && m.next) {
      var how = el("div", "pp-how"); how.appendChild(el("b", "", "How to pay"));
      if (m.pay && m.pay.upi) how.appendChild(el("p", "", "UPI: " + m.pay.upi));
      if (m.pay && m.pay.note) how.appendChild(el("p", "", m.pay.note));
      if (!m.pay) how.appendChild(el("p", "", "Your planner will share the payment details with you."));
      how.appendChild(el("p", "muted", "After you pay, your planner records it and your receipt shows on your event page."));
      box.appendChild(how);
      // R258 (0445): "Pay this payment" - one-time code, how to pay, "I have paid" (portal-pay.js; shows nothing before 0445 / in a free trial)
      if (global.HelmClientPay && global.HelmClientPay.mount) { var cp = el("div", "pp-pay"); cp.hidden = true; box.appendChild(cp); global.HelmClientPay.mount(cp, { token: global.HelmClientPay.tokenOf(), money: opts.money, date: opts.date }); }
    }
    return true;
  };
})(typeof window !== "undefined" ? window : globalThis);
