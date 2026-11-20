/* money-safety-ui.js - R239 / Phase 3 money safety (0404). One self-mounting card on Settlement:
     data-msf-mount="settlement"   - "Freeze now" (admin + reason; unfreeze = admin + reason; the log)
                                   - Receipts: every client receipt; "Reverse" adds a minus receipt (never an edit of the original)
                                   - Credit on account: money a client paid over the balance; Apply (when something is due) / Given back
                                   - Voided entries: struck through, with who / when / why
   Fills once the page shows #app and only when the server answers (Finance / Settlement view - re-checked on the server).
   On a database without 0404 the card stays hidden. DOM via createElement / textContent only. Every amount carries
   data-money so "Hide amounts" masks it. */
(function (global) {
  "use strict";
  var S = function () { return global.BPStore; };
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; }
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); }
  function money(node) { node.setAttribute("data-money", ""); return node; }
  function qid() { var p = new URLSearchParams(global.location.search); return p.get("quote") || p.get("id") || ""; }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function errText(e) {
    try { if (global.BPUI && global.BPUI.friendlyError) return global.BPUI.friendlyError(e, { action: "save this" }); } catch (_) {}
    return (e && e.message) ? String(e.message).slice(0, 240) : "Something went wrong - try again.";
  }
  function toast(t, kind) { try { if (global.BPUI && global.BPUI.toast) global.BPUI.toast(t, { type: kind || "ok" }); } catch (_) {} }
  function niceDate(iso) {
    if (!iso) return ""; var d = new Date(String(iso).length <= 10 ? iso + "T00:00:00" : iso); if (isNaN(d.getTime())) return "";
    return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  }
  async function fmtFor(quoteId) {
    var B = S(), cfg = null;
    if (quoteId) { try { var ev = await B.quotes.get(quoteId); cfg = ev ? B.quoteTax(ev) : null; } catch (e) { cfg = null; } }
    return function (n) { try { return cfg ? B.quoteMoney(n, cfg) : B.studioMoney(n); } catch (e) { return String(Math.round(Number(n) || 0)); } };
  }
  function btn(text, cls) { var b = el("button", "btn" + (cls ? " " + cls : ""), text); b.type = "button"; return b; }
  function busy(b, on) { if (!b) return; if (on) { b.setAttribute("data-label", b.textContent); b.textContent = "Saving…"; b.disabled = true; } else { b.textContent = b.getAttribute("data-label") || b.textContent; b.disabled = false; } }
  function table(cols, caption) {
    var w = el("div", "table-scroll mlk-tw"), t = el("table", "mlk-table"), th = el("thead"), tr = el("tr");
    t.setAttribute("data-tm", "off");
    if (caption) t.appendChild(el("caption", "sr-only", caption));
    cols.forEach(function (c) { var h = el("th", c[1] || null, c[0]); h.scope = "col"; tr.appendChild(h); });
    th.appendChild(tr); t.appendChild(th); var b = el("tbody"); t.appendChild(b); w.appendChild(t);
    return { wrap: w, body: b };
  }
  function td(text, cls, label) { var c = el("td", cls || null, text); if (label) c.setAttribute("data-label", label); return c; }
  function moneyTd(v, fmt, label, cls) {
    var c = el("td", "num" + (cls ? " " + cls : "")); if (label) c.setAttribute("data-label", label);
    c.appendChild(money(el("span", num(v) < 0 ? "neg" : null, num(v) < 0 ? "−" + fmt(Math.abs(num(v))) : fmt(v)))); return c;
  }
  async function ask(msg, title, ok) {
    var why = null; try { why = await global.BPUI.prompt(msg, { title: title, label: "Reason (5 to 500 characters)", required: true, okLabel: ok }); } catch (e) { why = null; }
    why = String(why || "").trim();
    if (!why) return null;
    if (why.length < 5) { toast("Give a reason of at least 5 characters.", "err"); return null; }
    return why.slice(0, 500);
  }
  var KIND = { refund: "Refund / recovery", claim: "Expense claim", cost: "Cost line", milestone: "Milestone" };

  async function mountSettlement(box) {
    var B = S(), id = qid(); if (!id || !B || !B.moneySafety) { box.hidden = true; return; }
    var M = B.moneySafety, fmt = await fmtFor(id);
    var canFin = false, canFinEdit = false, canSetEdit = false;
    try { canFin = (await B.auth.canView("finance")) || (await B.auth.canView("settlement")); } catch (e) { canFin = false; }
    if (!canFin) { box.hidden = true; return; }
    try { canFinEdit = await B.auth.canEditArea("finance"); } catch (e) { canFinEdit = false; }
    try { canSetEdit = await B.auth.canEditArea("settlement"); } catch (e) { canSetEdit = false; }

    async function draw() {
      var fr = null, cr = null, vd = null, pays = null;
      try { fr = await M.freeze(id); } catch (e) { fr = null; }
      if (!fr) { box.hidden = true; return; }        // a database without 0404 (or no access)
      try { cr = await M.credits(id); } catch (e) { cr = null; }
      try { vd = await M.voided(id); } catch (e) { vd = null; }
      try { pays = await B.milestones.payments(id); } catch (e) { pays = null; }
      clear(box); box.hidden = false; box.classList.add("card", "mlk-card", "msf-card");
      box.appendChild(el("h2", null, "🛡 Money safety"));
      box.appendChild(el("p", "sub", "Nothing on this page is ever deleted: a wrong entry is voided (kept, crossed out, left out of the totals), a payment is undone with a reversing entry, and money paid over the balance is kept as a credit."));

      // ---- Freeze now
      var fz = el("div", "mlk-state msf-freeze" + (fr.frozen ? " warn" : ""));
      if (fr.frozen) {
        fz.appendChild(el("b", null, "🔒 The money on this event is frozen"));
        fz.appendChild(el("p", null, "By " + (fr.by || "an admin") + " on " + niceDate(fr.at) + ": " + (fr.reason || "") + ". Cost lines, claims, refunds, milestones, change orders and the price can't be changed. Client payments and vendor payouts still go in."));
      } else if (fr.closed) {
        fz.appendChild(el("b", null, "This event is closed - its money is already locked."));
      } else {
        fz.appendChild(el("b", null, "Freeze now"));
        fz.appendChild(el("p", null, "An admin can lock this event's money before closing (for example while the accounts are checked). Nothing changes in the figures."));
      }
      if (fr.can_set && !(fr.closed && !fr.frozen)) {
        var fb = btn(fr.frozen ? "Unfreeze" : "Freeze now", fr.frozen ? "" : "primary"); fz.appendChild(fb);
        fb.addEventListener("click", async function () {
          var why = await ask(fr.frozen ? "Why is the money unfrozen? (kept in the log)" : "Why freeze the money now? (kept in the log)", fr.frozen ? "Unfreeze the money?" : "Freeze the money?", fr.frozen ? "Unfreeze" : "Freeze now");
          if (!why) return; busy(fb, true);
          try { await M.setFreeze(id, !fr.frozen, why); toast(fr.frozen ? "Unfrozen." : "Money frozen."); changed(); } catch (e) { toast(errText(e), "err"); busy(fb, false); }
        });
      }
      if ((fr.log || []).length) {
        var lg = el("details", "msf-log"); lg.appendChild(el("summary", null, "Freeze log (" + fr.log.length + ")"));
        fr.log.forEach(function (l) { lg.appendChild(el("div", "mlk-muted", niceDate(l.at) + " · " + (l.action === "freeze" ? "Frozen" : "Unfrozen") + " by " + (l.by || "?") + ": " + (l.reason || ""))); });
        fz.appendChild(lg);
      }
      box.appendChild(fz);

      // ---- Receipts (reverse)
      var rows = (pays || []).filter(function (p) { return p && p.status === "paid"; });
      if (rows.length) {
        box.appendChild(el("h3", null, "Receipts"));
        var rev = M.reversalOf(rows);
        var t = table([["Date", ""], ["Receipt", ""], ["Amount", "num"], ["", ""]], "Client receipts");
        rows.slice().sort(function (a, b) { return String(a.paid_at || a.created_at || "").localeCompare(String(b.paid_at || b.created_at || "")); }).forEach(function (p) {
          var tr = el("tr", rev[p.id] ? "msf-void" : null);
          tr.appendChild(td(niceDate(p.paid_at || p.created_at), null, "Date"));
          var rc = td(p.receipt_no || "—", rev[p.id] ? "msf-strike" : null, "Receipt");
          if (p.reverses_payment_id) rc.appendChild(el("div", "mlk-muted", "Reversal: " + (p.reversal_reason || "")));
          else if (p.method === "credit") rc.appendChild(el("div", "mlk-muted", "From the credit on account"));
          tr.appendChild(rc);
          tr.appendChild(moneyTd(p.amount, fmt, "Amount", rev[p.id] ? "msf-strike" : null));
          var ac = el("td");
          if (rev[p.id]) ac.appendChild(el("span", "mlk-muted", "reversed by " + (rev[p.id].receipt_no || "a reversal")));
          else if (!p.reverses_payment_id && num(p.amount) > 0 && p.method !== "credit" && canFinEdit) {
            var rb = btn("Reverse", "mlk-link"); rb.setAttribute("aria-label", "Reverse receipt " + (p.receipt_no || "")); ac.appendChild(rb);
            rb.addEventListener("click", async function () {
              var why = await ask("A minus receipt cancels this payment (for example a bounced cheque). The original stays in the history. Why?", "Reverse this payment?", "Reverse");
              if (!why) return; busy(rb, true);
              var scope = "msf-rev:" + p.id, key = M.key.get(scope, why);
              try { await M.reverse(p.id, why, key); M.key.done(scope); toast("Payment reversed - the milestones it covered are due again."); changed(); }
              catch (e) { toast(errText(e), "err"); busy(rb, false); }
            });
          }
          tr.appendChild(ac); t.body.appendChild(tr);
        });
        box.appendChild(t.wrap);
      }

      // ---- Credit on account
      var crs = cr && Array.isArray(cr.rows) ? cr.rows : [];
      if (crs.length) {
        box.appendChild(el("h3", null, "Credit on account"));
        var sum = el("p", "mlk-sum"); sum.appendChild(document.createTextNode("Open credit: "));
        sum.appendChild(money(el("b", null, fmt(cr.open_total)))); sum.appendChild(document.createTextNode(" · due now: "));
        sum.appendChild(money(el("b", null, fmt(cr.due_now)))); box.appendChild(sum);
        if (num(cr.open_total) > 0) box.appendChild(el("p", "mlk-hint", "Money the client paid over the balance. It is not revenue. Apply it when something is due again (a change order), or mark it given back - before closing the event."));
        var ct = table([["Date", ""], ["Credit", "num"], ["Status", ""], ["", ""]], "Credit on account");
        crs.forEach(function (c) {
          var tr = el("tr", c.status === "open" ? null : "msf-done");
          tr.appendChild(td(niceDate(c.created_at), null, "Date")); tr.appendChild(moneyTd(c.amount, fmt, "Credit"));
          var st = c.status === "open" ? "Open" : c.status === "applied" ? "Applied " + niceDate(c.closed_at) : "Given back " + niceDate(c.closed_at) + (c.close_note ? " - " + c.close_note : "");
          tr.appendChild(td(st, null, "Status"));
          var ac = el("td");
          if (c.status === "open") {
            if (cr.can_apply && num(cr.due_now) > 0.005) {
              var ab = btn("Apply to the balance", "mlk-link"); ac.appendChild(ab);
              ab.addEventListener("click", async function () {
                busy(ab, true);
                try { var r = await M.applyCredit(c.id); toast("Applied " + fmt(r && r.applied) + " to the balance."); changed(); } catch (e) { toast(errText(e), "err"); busy(ab, false); }
              });
            }
            if (cr.can_refund) {
              var gb = btn("Given back", "mlk-link"); ac.appendChild(gb);
              gb.addEventListener("click", async function () {
                var why = await ask("How was the credit given back to the client? (for example: bank transfer, UTR 1234)", "Credit given back?", "Mark given back");
                if (!why) return; busy(gb, true);
                try { await M.refundCredit(c.id, why); toast("Credit marked as given back."); changed(); } catch (e) { toast(errText(e), "err"); busy(gb, false); }
              });
            }
          }
          tr.appendChild(ac); ct.body.appendChild(tr);
        });
        box.appendChild(ct.wrap);
      }

      // ---- Voided entries (struck through)
      var vds = Array.isArray(vd) ? vd : [];
      if (vds.length) {
        box.appendChild(el("h3", null, "Voided entries"));
        box.appendChild(el("p", "mlk-hint", "Kept for the record. They count 0 in every total."));
        var vt = table([["Voided", ""], ["Entry", ""], ["Amount", "num"], ["Why", ""]], "Voided entries");
        vds.forEach(function (v) {
          var tr = el("tr", "msf-void");
          tr.appendChild(td(niceDate(v.voided_at) + (v.by ? " · " + v.by : ""), null, "Voided"));
          tr.appendChild(td((KIND[v.kind] || v.kind) + ": " + (v.label || ""), "msf-strike", "Entry"));
          tr.appendChild(moneyTd(v.amount, fmt, "Amount", "msf-strike"));
          tr.appendChild(td(v.reason || "", null, "Why")); vt.body.appendChild(tr);
        });
        box.appendChild(vt.wrap);
      }
    }
    function changed() { try { document.dispatchEvent(new CustomEvent("helm:money-safety-changed")); } catch (_) {} draw(); }
    document.addEventListener("helm:settlement-loaded", function () { draw(); });
    await draw();
  }

  var MOUNTS = { settlement: mountSettlement };
  function whenShown(gate, fn) {
    if (!gate) { fn(); return; }
    var done = false, run = function () { if (done || gate.hidden) return; done = true; obs.disconnect(); fn(); };
    var obs = new MutationObserver(run); obs.observe(gate, { attributes: true, attributeFilter: ["hidden"] }); run();
  }
  function start() {
    Array.prototype.forEach.call(document.querySelectorAll("[data-msf-mount]"), function (n) {
      var fn = MOUNTS[n.getAttribute("data-msf-mount")]; if (!fn) return;
      var gid = n.getAttribute("data-msf-gate"), gate = gid === "none" ? null : document.getElementById(gid || "app");
      whenShown(gate, function () { Promise.resolve().then(function () { return fn(n); }).catch(function (e) { try { console.warn("money safety:", e && e.message); } catch (_) {} n.hidden = true; }); });
    });
  }
  global.HelmMoneySafety = { mountSettlement: mountSettlement };
  if (typeof document === "undefined") return;
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})(typeof window !== "undefined" ? window : globalThis);
