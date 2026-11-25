/* payment-followup.js - R258 (0445, owner: "remind the studio, the studio will contact the client"): what the studio does about one open payment,
   on the payment card (payment-schedule.js calls attach after every read) and the compact "Payments" line of the event page (#payLine):
   - "Send reminder to the client" with the exact words first (payment_reminder_preview queues nothing), then BPStore.comms.remindNow; afterwards
     "Reminder sent 25 Nov 10:12 by Ananya";
   - "Call +91 ..." ; "Client says paid ..." with Record this payment (the quote flow's step 10, amount + reference filled in) / Not received.
   Everything comes from payment_followup_get (Finance view, own studio, checked in the database). Older server / not allowed = nothing is added.
   Amounts carry data-money. DOM via createElement + textContent only. The pure helpers (stamp, stateOf, lineModel, prefill, refNote) are unit-tested. */
(function (global) {
  "use strict";
  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var HOW = { upi: "UPI", bank: "bank transfer", cash: "cash", card: "card", other: "another way" };
  // ---- pure ------------------------------------------------------------------------------------------------------------
  // "25 Nov 10:12" in the studio's time zone
  function stamp(iso, tz) {
    var d = new Date(iso); if (isNaN(d)) return "";
    try {
      var p = {}; new Intl.DateTimeFormat("en-GB", { timeZone: tz || undefined, day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d).forEach(function (x) { p[x.type] = x.value; });
      return Number(p.day) + " " + MON[Number(p.month) - 1] + " " + p.hour + ":" + p.minute;
    } catch (e) { return ""; }
  }
  // the words of the last reminder of a payment ("" = none)
  function reminderText(r, tz) {
    if (!r || !r.at) return "";
    var who = r.by ? " by " + r.by : "", t = stamp(r.at, tz);
    if (r.status === "sent") return "Reminder sent " + t + who;
    if (r.status === "pending") return "Reminder on its way, asked " + t + who;
    return "Reminder not sent, asked " + t + who;
  }
  function claimText(c, money, tz) {
    return "Client says paid: " + money(c.amount) + " by " + (HOW[c.method] || "another way") + (c.reference ? ", reference " + c.reference : "") + ", " + stamp(c.at, tz) + (c.code ? ". Confirmed with a one-time code." : ". Not confirmed with a code.");
  }
  // one payment in one word for the chip: claim > overdue > today > reminder sent > due
  function stateOf(row, f) {
    if (f && f.claim) return { key: "claim", text: "Client says paid" };
    if (row.state === "overdue" || (row.days != null && row.days < 0)) return { key: "overdue", text: "Overdue " + (-row.days) + (row.days === -1 ? " day" : " days") };
    if (row.days === 0) return { key: "due", text: "Due today" };
    if (f && f.reminder && f.reminder.status === "sent") return { key: "sent", text: "Reminder sent" };
    return { key: "due", text: "Due" };
  }
  function openRows(data) { return (data && data.rows || []).filter(function (r) { return r && /^(due|invoiced|overdue|part_paid)$/.test(r.state) && Number(r.remaining) > 0.5; }); }
  // the compact line of the event page -> null (nothing open) | { label, left, due, claim (count), chip }
  function lineModel(data, f) {
    var open = openRows(data); if (!open.length) return null;
    var fr = (f && f.rows) || {}, n = open[0], claims = open.filter(function (r) { return fr[r.id] && fr[r.id].claim; });
    var st = stateOf(n, fr[n.id]); if (claims.length && st.key !== "claim") st = { key: "claim", text: "Client says paid" };
    if (f && f.held) st = { key: "due", text: "After approval" };
    return { id: n.id, label: String(n.label || "Payment").replace(/\s*\(\d+(\.\d+)?%\)\s*$/, ""), left: Number(n.remaining), due: n.due_date || "", chip: st, more: open.length - 1 };
  }
  // which payments show the buttons: the next one, every late / due one, one the client says is paid
  function active(data, f) {
    var fr = (f && f.rows) || {};
    return openRows(data).filter(function (r, i) { return i === 0 || (r.days != null && r.days <= 0) || (fr[r.id] && fr[r.id].claim); }).map(function (r) { return r.id; });
  }
  // what the recording form is given (this browser tab only, 2 hours)
  var KEY = "helm_pay_prefill:";
  function putPrefill(quoteId, c, now) { try { global.sessionStorage.setItem(KEY + quoteId, JSON.stringify({ amount: Number(c.amount) || 0, method: String(c.method || ""), reference: String(c.reference || "").slice(0, 80), claim: c.id || null, ts: now || Date.now() })); } catch (e) {} }
  function prefill(quoteId, now) {
    try { var o = JSON.parse(global.sessionStorage.getItem(KEY + quoteId) || "null"); return o && o.amount > 0 && (now || Date.now()) - Number(o.ts || 0) < 7200000 ? o : null; } catch (e) { return null; }
  }
  function clearPrefill(quoteId) { try { global.sessionStorage.removeItem(KEY + quoteId); } catch (e) {} }
  // the note kept with the receipt, only when the amount is the one the client named
  function refNote(quoteId, amount) {
    var o = prefill(quoteId); if (!o || Math.abs(o.amount - Number(amount)) > 0.5) return null;
    return ("Client paid by " + (HOW[o.method] || "another way") + (o.reference ? ", reference " + o.reference : "")).slice(0, 200);
  }
  function errText(e) {
    var s = String((e && (e.message || e.code)) || "");
    if (/trial/i.test(s)) return "Not available in the free trial: nothing is sent to a client.";
    if (/not authori[sz]ed|42501/i.test(s)) return "You don't have permission to do this.";
    return s.slice(0, 200) || "Something went wrong - please try again.";
  }
  var api = { stamp: stamp, reminderText: reminderText, claimText: claimText, stateOf: stateOf, lineModel: lineModel, active: active, putPrefill: putPrefill, prefill: prefill, clearPrefill: clearPrefill, refNote: refNote, openRows: openRows, errText: errText };
  global.HelmPayFollow = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof document === "undefined") return;

  // ---- DOM -------------------------------------------------------------------------------------------------------------
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function money(n) { var B = global.BPStore; try { if (B && B.studioMoney) return B.studioMoney(Number(n) || 0); } catch (e) {} return "₹" + Math.round(Number(n) || 0).toLocaleString("en-IN"); }
  function tz() { try { return global.BPStore.studioTimezone ? global.BPStore.studioTimezone() : undefined; } catch (e) { return undefined; } }
  function toast(t, kind) { var U = global.BPUI; if (U && U.toast) U.toast(t, { type: kind || "ok" }); }
  function btn(text, cls, fn) { var b = el("button", "btn sm pfu-b" + (cls ? " " + cls : ""), text); b.type = "button"; b.addEventListener("click", function () { fn(b); }); return b; }
  function mline(text) { var p = el("p", "pfu-t", text); p.setAttribute("data-money", ""); return p; }
  function onFlow() { try { return /(^|\/)flow(\.html)?\/?$/.test(String(location.pathname || "")); } catch (e) { return false; } }

  var seq = 0;
  api.attach = async function (o) {
    var my = ++seq, B = global.BPStore, f = null, P = B && B.paySchedule;
    fillForm(o.quoteId);
    if (!P || !P.followUp || !o.data || !Array.isArray(o.data.rows) || !o.data.rows.length) { line(o, null); return null; }
    try { f = await P.followUp(o.quoteId); } catch (e) { f = null; }
    if (my !== seq && o.box && !o.box.isConnected) return null;
    line(o, f);
    if (!f || !o.tbody || !o.tbody.isConnected) return f;
    paint(o, f); scrollHere(o.box);
    return f;
  };

  function paint(o, f) {
    Array.prototype.slice.call(o.box.querySelectorAll(".pfu")).forEach(function (x) { x.parentNode.removeChild(x); });
    var rows = o.data.rows, trs = Array.prototype.slice.call(o.tbody.querySelectorAll("tr.psch-row")), show = active(o.data, f);
    rows.forEach(function (r, i) {
      var fr = (f.rows || {})[r.id], tr = trs[i]; if (!fr || !tr || f.held || f.live === false) return;
      if (show.indexOf(r.id) < 0 && !(fr.reminder && Number(r.remaining) > 0.5)) return;
      var x = el("tr", "pfu"), td = el("td", "pfu-c"); td.colSpan = 5; x.appendChild(td);
      if (fr.claim) {
        var c = el("div", "pfu-claim"); c.appendChild(mline(claimText(fr.claim, money, tz())));
        if (f.can_edit) {
          var ca = el("div", "pfu-acts");
          ca.appendChild(btn("Record this payment", "primary", function () { record(o, r, fr.claim); }));
          ca.appendChild(btn("Not received", "", function (b) { close(o, fr.claim, b); })); c.appendChild(ca);
        }
        td.appendChild(c);
      }
      var rt = reminderText(fr.reminder, tz()); if (rt) td.appendChild(el("p", "pfu-t pfu-sent", rt));
      if (show.indexOf(r.id) >= 0 && !fr.claim) {
        var a = el("div", "pfu-acts");
        if (f.can_send && !f.trial && !f.demo) a.appendChild(btn(fr.reminder ? "Send another reminder" : "Send reminder to the client", "", function (b) { preview(o, r, td, b); }));
        else if (f.can_send && f.trial) a.appendChild(el("span", "pfu-t", "Free trial: no reminder is sent to the client."));
        if (f.phone) { var t = el("a", "btn sm pfu-b", "Call " + f.phone); t.href = "tel:" + f.phone.replace(/[^0-9+]/g, ""); a.appendChild(t); }
        if (a.firstChild) td.appendChild(a);
      }
      if (td.firstChild) tr.parentNode.insertBefore(x, tr.nextSibling);
    });
    var foot = o.box.querySelector(".psch-foot");
    if (foot && f.team && !f.held) {
      var t2 = f.team.on === false ? "Payment reminders for your team are off (Settings, Payment schedules)."
        : "Your team is reminded at " + f.team.at + ": the working day before, on the day, and every 3 days while it is late." + (f.auto ? "" : " The client is not reminded by itself.");
      var p = el("p", "psch-note pfu", t2); foot.insertBefore(p, foot.firstChild);
    }
  }

  // the exact words first; "Send now" queues it through the same function as always
  async function preview(o, r, td, b) {
    var old = td.querySelector(".pfu-prev"); if (old) { td.removeChild(old); return; }
    b.disabled = true; var d = null;
    try { d = await global.BPStore.paySchedule.reminderPreview(r.id); } catch (e) { toast(errText(e), "err"); b.disabled = false; return; }
    b.disabled = false;
    if (!d) return;
    if (d.already) { toast("A reminder for this payment was sent in the last 10 minutes.", "info"); return; }
    var box = el("div", "pfu-prev"); box.setAttribute("role", "group"); box.setAttribute("aria-label", "Reminder to the client");
    var items = (d.items || []).filter(function (i) { return i.channel !== "whatsapp" || d.wa; }), off = (d.items || []).length - items.length;
    if (!items.length) { toast(off ? "WhatsApp is not connected. Add the client's e-mail or connect WhatsApp in Settings." : "There is no e-mail for this client.", "err"); return; }
    items.forEach(function (i) {
      box.appendChild(el("p", "pfu-t pfu-to", (i.channel === "whatsapp" ? "WhatsApp to +" : "E-mail to ") + i.to));
      if (i.channel !== "whatsapp" && i.subject) box.appendChild(el("p", "pfu-t pfu-sub", i.subject));
      var q = el("blockquote", "pfu-q", i.text || ""); q.setAttribute("data-money", ""); box.appendChild(q);
    });
    if (off) box.appendChild(el("p", "pfu-t", "WhatsApp is not connected, so it goes by e-mail only."));
    var acts = el("div", "pfu-acts");
    var go = btn("Send now", "primary", async function () {
      go.disabled = true;
      try {
        var x = await global.BPStore.comms.remindNow(r.id);
        toast(x && x.queued ? "Reminder is on its way to the client." : "A reminder for this payment was just sent.", x && x.queued ? "ok" : "info");
        if (o.reload) await o.reload();
      } catch (e) { toast(errText(e), "err"); go.disabled = false; }
    });
    acts.appendChild(go); acts.appendChild(btn("Cancel", "", function () { if (box.parentNode) box.parentNode.removeChild(box); try { b.focus(); } catch (e) {} }));
    box.appendChild(acts); td.appendChild(box); try { go.focus(); } catch (e) {}
  }
  function record(o, r, c) {
    putPrefill(o.quoteId, c);
    if (onFlow()) { fillForm(o.quoteId); var s = document.getElementById("sec-pay"); if (s) s.scrollIntoView({ block: "start" }); return; }
    var h = "flow.html?quote=" + encodeURIComponent(o.quoteId) + "#sec-pay"; if (global.HelmUrl && global.HelmUrl.upgrade) h = global.HelmUrl.upgrade(h);
    location.href = h;
  }
  async function close(o, c, b) {
    var U = global.BPUI, q = "The notice is closed and the client may tell you again. Their payment stays due.";
    if (U && U.confirm && !(await U.confirm(q, { title: "Not received?", okLabel: "Not received" }))) return;
    b.disabled = true;
    try { await global.BPStore.paySchedule.claimClose(c.id, "not_received"); toast("Closed. The payment stays due."); if (o.reload) await o.reload(); }
    catch (e) { toast(errText(e), "err"); b.disabled = false; }
  }
  // the quote flow's recording form: amount, method (where the form has it) and the reference in words
  function fillForm(quoteId) {
    var o = prefill(quoteId), amt = document.getElementById("pay_amount"); if (!o || !amt || !onFlow()) return;
    var old = document.getElementById("pfuForm"); if (old) return;
    amt.value = String(o.amount); try { amt.dispatchEvent(new Event("input", { bubbles: true })); } catch (e) {}
    var host = document.getElementById("payAdv"); if (!host) return;
    var p = el("p", "psch-soft pfu-form"); p.id = "pfuForm"; p.setAttribute("role", "status");
    var s = el("span", "", "The client says this is paid by " + (HOW[o.method] || "another way") + (o.reference ? ", reference " + o.reference : "") + ". Check your account, then press Record. The reference is kept with the receipt."); p.appendChild(s);
    host.parentNode.insertBefore(p, host);
  }
  // recorded: the form is empty again
  api.recorded = function (quoteId) { clearPrefill(quoteId); var p = document.getElementById("pfuForm"); if (p && p.parentNode) p.parentNode.removeChild(p); };
  function line(o, f) {
    var box = document.getElementById("payLine"); if (!box) return;
    while (box.firstChild) box.removeChild(box.firstChild);
    var m = lineModel(o.data, f); box.hidden = !m; if (!m) return;
    var a = el("a", "pfu-line"); a.href = "#paySchedCard";
    a.appendChild(el("b", "", "Payments")); a.appendChild(el("span", "", "Next: " + m.label));
    var amt = el("span", "pfu-amt", money(m.left)); amt.setAttribute("data-money", ""); a.appendChild(amt);
    a.appendChild(el("span", "", m.due ? (o.dayText ? o.dayText(m.due, o.data.today) : m.due) : "No date yet"));
    a.appendChild(el("span", "psch-chip pfu-chip pfu-chip-" + m.chip.key, m.chip.text));
    if (m.more > 0) a.appendChild(el("span", "pfu-more", "+ " + m.more + " more"));
    a.addEventListener("click", function (e) { var c = document.getElementById("paySchedCard"); if (!c) return; e.preventDefault(); c.scrollIntoView({ behavior: "smooth", block: "start" }); c.setAttribute("tabindex", "-1"); try { c.focus({ preventScroll: true }); } catch (x) {} });
    box.appendChild(a);
  }
  // the bell opens event.html#paySchedCard: the card is only there after the first read
  var scrolled = false;
  function scrollHere(box) {
    if (scrolled || !box || !box.id) return;
    try { if (String(location.hash || "") !== "#" + box.id) return; } catch (e) { return; }
    scrolled = true; setTimeout(function () { try { box.scrollIntoView({ block: "start" }); } catch (e) {} }, 250);
  }
})(typeof window !== "undefined" ? window : globalThis);
