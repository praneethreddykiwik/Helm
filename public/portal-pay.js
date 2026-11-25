/* portal-pay.js - R258 (0445, owner: "the second payment needs OTP and payment, third payment, everything same"): the client's "Pay this payment" step
   on the event's own private link (client portal, and the approval page after the approval). For every payment that is due or next:
   1 confirm with a one-time code to the e-mail / WhatsApp the planner has on file (send-otp pay_email / pay_whatsapp; its own code table - never an
     approval), 2 how to pay (the studio's UPI ID / note; online payment is on hold), 3 "I have paid" with the amount and the reference.
   It records NO money: the studio gets a notice and records the payment. Until this server can send payment codes the step goes on without one and
   the studio sees "Not confirmed with a code". Reads / writes only with the page's own link token (public_payment_steps / _code_verify / _claim).
   No answer / free trial / not approved / nothing open = nothing is shown. DOM via createElement + textContent only (no HTML strings). */
/* global inr */
(function (global) {
  "use strict";
  var HOW = [["upi", "UPI"], ["bank", "Bank transfer"], ["cash", "Cash"], ["card", "Card"], ["other", "Another way"]];
  function nameOf(label) { return String(label || "Payment").replace(/\s*\(\d+(?:\.\d+)?%\)\s*$/, "").slice(0, 80) || "Payment"; }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  // the answer of public_payment_steps -> null (nothing to show) | { rows: [{id,name,left,amount,due,late,claim}], channels: [[key, masked]], code, pay }
  function model(s) {
    if (!s || s.on !== true || !Array.isArray(s.rows) || !s.rows.length) return null;
    var ch = s.channels && typeof s.channels === "object" ? s.channels : {}, list = [];
    ["email", "whatsapp"].forEach(function (k) { if (typeof ch[k] === "string" && ch[k]) list.push([k, ch[k].slice(0, 120)]); });
    return { rows: s.rows.filter(function (r) { return r && r.id && num(r.left) > 0; }).slice(0, 10).map(function (r) {
      var due = /^\d{4}-\d{2}-\d{2}/.test(String(r.due_date || "")) ? String(r.due_date).slice(0, 10) : "";
      return { id: String(r.id), name: nameOf(r.label), left: num(r.left), amount: num(r.amount), due: due, late: !!(due && s.today && due < s.today), today: !!(due && due === s.today), claim: r.claim || null };
    }), channels: list, code: s.code === true, pay: s.pay || null };
  }
  function checkClaim(o, left) {
    var a = String(o.amount == null ? "" : o.amount).replace(/[,\s]/g, "");
    if (!/^\d{1,9}(\.\d{1,2})?$/.test(a) || !(Number(a) > 0)) return { ok: false, field: "amount", error: "Enter the amount you paid." };
    if (Number(a) > left + 0.5) return { ok: false, field: "amount", error: "That is more than what is left to pay." };
    if (!HOW.some(function (h) { return h[0] === o.method; })) return { ok: false, field: "method", error: "Choose how you paid." };
    var ref = String(o.reference || "").trim().slice(0, 80);
    if ((o.method === "upi" || o.method === "bank") && !ref) return { ok: false, field: "reference", error: "Enter the reference number of your payment." };
    return { ok: true, amount: Number(a), method: o.method, reference: ref };
  }
  var api = { model: model, checkClaim: checkClaim, nameOf: nameOf };
  global.HelmClientPay = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof document === "undefined") return;

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function btn(text, cls, fn) { var b = el("button", "cp-btn" + (cls ? " " + cls : ""), text); b.type = "button"; if (fn) b.addEventListener("click", function () { fn(b); }); return b; }
  function err(e) { var s = String((e && e.message) || ""); return /fetch|network|timeout/i.test(s) || !s ? "Could not reach the server. Please try again." : s.slice(0, 200); }
  var uid = 0;

  // opts: { token, money(n), date(iso) }
  api.mount = async function (box, opts) {
    var B = global.BPStore, P = B && B.paySchedule;
    if (!box || !opts || !opts.token || !P || !P.publicSteps) return null;
    var token = opts.token, money = opts.money, date = opts.date, data = null, live = {};
    async function load() {
      var s = null; try { s = await P.publicSteps(token); } catch (e) { s = null; }
      data = model(s); paint();
      return data;
    }
    function paint() {
      while (box.firstChild) box.removeChild(box.firstChild);
      box.hidden = !data || !data.rows.length; if (box.hidden) return;
      box.classList.add("cp");
      data.rows.forEach(function (r) { box.appendChild(card(r)); });
    }
    function card(r) {
      var c = el("section", "cp-card"), h = el("div", "cp-head"), id = "cp" + (++uid), t = el("h3", "cp-t", r.name); t.id = id; c.setAttribute("aria-labelledby", id);
      h.appendChild(t); h.appendChild(el("b", "cp-amt", money(r.left))); c.appendChild(h);
      var part = r.left < r.amount - 0.5 ? money(r.left) + " of " + money(r.amount) + " is left. " : "";
      c.appendChild(el("p", "cp-sub", part + (!r.due ? "Your planner will confirm the date." : r.late ? "Was due " + date(r.due) + "." : r.today ? "Due today." : "Due " + date(r.due) + ".")));
      if (r.claim) {
        c.appendChild(el("p", "cp-ok", "You told your planner you paid " + money(num(r.claim.amount)) + (r.claim.reference ? " (reference " + String(r.claim.reference).slice(0, 80) + ")" : "") + ". They will check and record it. Your receipt then shows on this page."));
        return c;
      }
      var body = el("div", "cp-body"), msg = el("p", "cp-msg"); msg.setAttribute("role", "status"); msg.setAttribute("aria-live", "polite");
      var go = btn("Pay this payment", "primary", function () { go.hidden = true; if (data.channels.length) ask(r, body, msg); else pay(r, body, msg, null); });
      c.appendChild(go); c.appendChild(body); c.appendChild(msg);
      return c;
    }
    function say(m, t, bad) { m.textContent = t || ""; m.className = "cp-msg" + (bad ? " is-bad" : ""); }
    // 1 the one-time code
    function ask(r, body, msg) {
      while (body.firstChild) body.removeChild(body.firstChild);
      body.appendChild(el("p", "cp-p", "First we confirm it is you: a one-time code to the contact your planner has for you."));
      var acts = el("div", "cp-acts");
      data.channels.forEach(function (c) { acts.appendChild(btn((c[0] === "email" ? "Send a code to " : "Send a code on WhatsApp to ") + c[1], "", function (b) { send(r, body, msg, c, b); })); });
      body.appendChild(acts);
    }
    async function send(r, body, msg, c, b) {
      b.disabled = true; say(msg, "Sending…");
      try {
        var a = await P.payCodeSend(token, r.id, c[0]);
        if (!a || a.live !== true) { say(msg, ""); pay(r, body, msg, null); return; }   // no code can go out here: go on without one
        say(msg, "Code sent to " + (a.masked || c[1]) + ". It works for 10 minutes."); enter(r, body, msg);
      } catch (e) {
        if (e && e.noCode && !data.code) { say(msg, ""); pay(r, body, msg, null); return; }
        say(msg, err(e), true); b.disabled = false;
      }
    }
    function enter(r, body, msg) {
      while (body.firstChild) body.removeChild(body.firstChild);
      var id = "cpc" + (++uid), l = el("label", "cp-l", "One-time code"), i = el("input", "cp-in"); l.htmlFor = id; i.id = id; i.inputMode = "numeric"; i.maxLength = 6; i.autocomplete = "one-time-code"; i.setAttribute("pattern", "[0-9]*");
      body.appendChild(l); body.appendChild(i);
      var acts = el("div", "cp-acts"), ok = btn("Confirm", "primary", verify), again = btn("Send another code", "", function () { say(msg, ""); ask(r, body, msg); });
      acts.appendChild(ok); acts.appendChild(again); body.appendChild(acts); i.focus();
      i.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); verify(); } });
      async function verify() {
        var code = i.value.replace(/\D/g, ""); if (code.length !== 6) { say(msg, "Enter the 6 numbers of the code.", true); i.focus(); return; }
        ok.disabled = true;
        try {
          var v = await P.payCodeVerify(token, r.id, code);
          if (v && v.ok) { say(msg, ""); pay(r, body, msg, v.proof); return; }
          say(msg, v && v.error === "incorrect_code" ? "That code is not right. " + (v.remaining > 0 ? v.remaining + (v.remaining === 1 ? " try" : " tries") + " left." : "Please send another code.") : "This code no longer works. Please send another one.", true);
        } catch (e) { say(msg, err(e), true); }
        ok.disabled = false; i.select();
      }
    }
    // 2 how to pay, 3 "I have paid"
    function pay(r, body, msg, proof) {
      while (body.firstChild) body.removeChild(body.firstChild);
      var how = el("div", "cp-how"); how.appendChild(el("b", "", "How to pay " + money(r.left)));
      var p = data.pay || {};
      if (p.upi) {
        var u = el("div", "cp-upi"), v = el("span", "cp-upi-v", p.upi); u.appendChild(el("span", "", "UPI: ")); u.appendChild(v);
        if (global.navigator && navigator.clipboard && navigator.clipboard.writeText) u.appendChild(btn("Copy", "sm", function (b) { navigator.clipboard.writeText(p.upi).then(function () { b.textContent = "Copied"; }, function () {}); }));
        how.appendChild(u);
      }
      if (p.note) how.appendChild(el("p", "cp-note", p.note));
      if (!p.upi && !p.note) how.appendChild(el("p", "cp-note", "Your planner will share the payment details with you."));
      body.appendChild(how);
      body.appendChild(el("p", "cp-p", "After you pay, tell your planner here. They check it and record it; your receipt then shows on this page."));
      var f = el("form", "cp-form"); f.noValidate = true;
      function fld(label, node, name) { var w = el("div", "cp-f"), l = el("label", "cp-l", label), id = "cpf" + (++uid); node.id = id; l.htmlFor = id; node.setAttribute("data-f", name); w.appendChild(l); w.appendChild(node); f.appendChild(w); return node; }
      var am = el("input", "cp-in"); am.inputMode = "decimal"; am.maxLength = 12; am.value = String(Math.round(r.left * 100) / 100); fld("Amount you paid", am, "amount");
      var me = el("select", "cp-in"); HOW.forEach(function (h) { var o = el("option", "", h[1]); o.value = h[0]; me.appendChild(o); }); fld("How you paid", me, "method");
      var rf = el("input", "cp-in"); rf.maxLength = 80; rf.autocomplete = "off"; fld("Reference number", rf, "reference");
      var sb = btn("I have paid", "primary"); sb.type = "submit"; f.appendChild(sb); body.appendChild(f);
      f.addEventListener("submit", async function (e) {
        e.preventDefault(); if (sb.disabled) return;
        var total = data.rows.reduce(function (t, x) { return t + x.left; }, 0), c = checkClaim({ amount: am.value, method: me.value, reference: rf.value }, Math.max(total, r.left));
        [am, me, rf].forEach(function (n) { n.removeAttribute("aria-invalid"); });
        if (!c.ok) { say(msg, c.error, true); var n = { amount: am, method: me, reference: rf }[c.field]; n.setAttribute("aria-invalid", "true"); n.focus(); return; }
        sb.disabled = true; say(msg, "Sending…");
        try { await P.payClaim(token, r.id, { amount: c.amount, method: c.method, reference: c.reference, proof: proof }); await load(); }
        catch (x) {
          sb.disabled = false; say(msg, err(x), true);
          if (/one-time code/i.test(String(x && x.message))) { data.code = true; if (data.channels.length) ask(r, body, msg); }
        }
      });
      try { (p.upi || p.note ? rf : am).focus({ preventScroll: true }); } catch (e) {}
    }
    await load();
    return { reload: load };
  };

  // the page's own link: the branded /<studio>/portal|quote/<token> or ?token=
  function tokenOf() {
    try { var L = global.BPStore && global.BPStore.links; var x = L && (L.parse("portal") || L.parse("quote")); if (x && x.ref) return x.ref; } catch (e) {}
    try { return new URLSearchParams(location.search).get("token"); } catch (e) { return null; }
  }
  api.tokenOf = tokenOf;
  // the portal: the step under the payment schedule, once the page shows the event
  function portal() {
    var box = document.getElementById("payStep"), app = document.getElementById("app"), done = false; if (!box || !app) return;
    function start() {
      if (done || app.hidden) return; done = true; if (mo) mo.disconnect();
      api.mount(box, { token: tokenOf(), money: pageMoney, date: function (d) { return global.BPStore.fmtDateIN ? global.BPStore.fmtDateIN(d) : d; } });
    }
    var mo = typeof MutationObserver === "function" ? new MutationObserver(start) : null;
    if (mo) mo.observe(app, { attributes: true, attributeFilter: ["hidden"] });
    start();
  }
  // the amounts as the page writes them (inr of portal.html knows the quote's own currency; a top-level const is not on window)
  function pageMoney(n) { try { if (typeof inr === "function") return inr(n); } catch (e) {} try { var B = global.BPStore; if (B && B.studioMoney) return B.studioMoney(n); } catch (e) {} return "₹" + Math.round(Number(n) || 0).toLocaleString("en-IN"); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", portal); else portal();
})(typeof window !== "undefined" ? window : globalThis);
