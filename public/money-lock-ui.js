/* money-lock-ui.js - R189 Money phase 1 "Lock the money" (0372). Self-mounting cards:
     data-mlk-mount="frozen"      Closure: the frozen P&L (v1, v2 ...), what changed, live vs frozen, "Freeze now",
                                  cost corrections / late adjustments (new rows, never edits)
     data-mlk-mount="attendance"  Closure: "Confirm attendance" - days / hours / overtime / allowance per person,
                                  suggested from crew check-ins; per-person pay only for the admin (the server decides)
     data-mlk-mount="tds"         Settlement: TDS the client deducted, Form 16A, reverse a wrong row
     data-mlk-mount="business"    Business: GST to pay and TDS by month
     data-mlk-mount="settings"    Settings: the studio money rules (overtime, half day, allowance, TDS, cancelled events,
                                  big gap, unplanned, frozen numbers, late adjustments)
   Each card fills once its page shows the gate element (data-mlk-gate, default #app) and only when the server answers
   (Finance view / Business / Settings - re-checked on the server). On a database without 0372 the card stays hidden.
   DOM via createElement / textContent only. Every amount carries data-money so privacy mode masks it. */
(function (global) {
  "use strict";
  var S = function () { return global.BPStore; };
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; }
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); }
  function money(node) { node.setAttribute("data-money", ""); return node; }
  function qid() { var p = new URLSearchParams(global.location.search); return p.get("quote") || p.get("id") || ""; }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function has(v) { return v !== null && v !== undefined && v !== ""; }
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
  function studioFmt(n) { try { return S().studioMoney(n); } catch (e) { return String(Math.round(Number(n) || 0)); } }
  function btn(text, cls) { var b = el("button", "btn" + (cls ? " " + cls : ""), text); b.type = "button"; return b; }
  function field(label, input, hint) {
    var f = el("div", "mlk-fld"), id = input.id || ("mlk_" + Math.random().toString(36).slice(2, 9)); input.id = id;
    var l = el("label", null, label); l.htmlFor = id; f.appendChild(l); f.appendChild(input);
    if (hint) f.appendChild(el("p", "mlk-hint", hint));
    return f;
  }
  function input(type, value, attrs) {
    var i = document.createElement("input"); i.type = type || "text"; if (has(value)) i.value = String(value);
    Object.keys(attrs || {}).forEach(function (k) { i.setAttribute(k, attrs[k]); }); return i;
  }
  function select(opts, value) {
    var s = document.createElement("select");
    opts.forEach(function (o) { var op = el("option", null, o[1]); op.value = o[0]; if (String(o[0]) === String(value)) op.selected = true; s.appendChild(op); });
    return s;
  }
  function check(label, on) {
    var w = el("label", "mlk-check"), c = document.createElement("input"); c.type = "checkbox"; c.checked = !!on;
    w.appendChild(c); w.appendChild(el("span", null, label)); return { wrap: w, box: c };
  }
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
    if (!has(v)) { c.appendChild(el("span", "mlk-muted", "—")); return c; }
    c.appendChild(money(el("span", num(v) < 0 ? "neg" : null, num(v) < 0 ? "−" + fmt(Math.abs(num(v))) : fmt(v)))); return c;
  }
  function card(box, title, sub) {
    clear(box); box.hidden = false; box.classList.add("card", "mlk-card");
    box.appendChild(el("h2", null, title)); if (sub) box.appendChild(el("p", "sub", sub)); return box;
  }
  function busy(b, on, label) { if (!b) return; if (on) { b.setAttribute("data-label", b.textContent); b.textContent = label || "Saving…"; b.disabled = true; } else { b.textContent = b.getAttribute("data-label") || b.textContent; b.disabled = false; } }
  var REASON = { close: "Closed", late_adjustment: "Late adjustment", manual_freeze: "Frozen by hand" };
  var CAT = function (k) { try { return S().moneyLedger.catLabel(k); } catch (e) { return k; } };

  // ---------------- 1) frozen P&L + corrections (Closure) ----------------
  async function mountFrozen(box) {
    var B = S(), id = qid(); if (!id || !B || !B.moneyLock) { box.hidden = true; return; }
    var fin = false; try { fin = await B.auth.canView("finance"); } catch (e) { fin = false; }
    if (!fin) { box.hidden = true; return; }
    var fmt = await fmtFor(id);
    async function draw() {
      var v; try { v = await B.moneyLock.versions(id); } catch (e) { v = null; }
      if (!v) { box.hidden = true; return; }
      card(box, "🔒 Frozen P&L", "When the event is closed Helm keeps a copy of the P&L that never changes. Later changes show here as a new version.");
      var cur = (v.versions || []).filter(function (x) { return x.current; })[0];
      var st = el("div", "mlk-state" + (v.frozen ? " ok" : v.closed ? " warn" : "")); st.setAttribute("role", "status");
      if (!v.closed) st.appendChild(el("b", null, "Not closed yet - the P&L is frozen automatically when you close the event."));
      else if (v.frozen && cur) {
        st.appendChild(el("b", null, "Frozen v" + cur.version + " · " + (REASON[cur.reason] || cur.reason) + " · " + niceDate(cur.at) + (cur.by ? " · " + cur.by : "")));
        var p = el("p"); p.appendChild(document.createTextNode("Net profit ")); p.appendChild(money(el("b", num(cur.net_profit) < 0 ? "neg" : null, fmt(cur.net_profit))));
        if (has(cur.margin_pct)) p.appendChild(document.createTextNode(" (" + cur.margin_pct + "% margin)"));
        p.appendChild(document.createTextNode(v.freeze_closed === false ? ". The studio shows live numbers for closed events (Settings → Money rules)." : ". Business, Settlement and reports use this figure."));
        st.appendChild(p);
        if (v.live_differs) {
          var lw = el("p", "mlk-warn"); lw.appendChild(document.createTextNode("Live numbers now say "));
          lw.appendChild(money(el("b", null, fmt(v.live && v.live.net_profit))));
          lw.appendChild(document.createTextNode(" (something changed after closing, e.g. a day rate). The frozen figure stays; re-open and close again to freeze the new numbers."));
          st.appendChild(lw);
        }
      } else {
        st.appendChild(el("b", null, "Closed, but not frozen"));
        st.appendChild(el("p", null, "This event was closed before frozen P&Ls existed (or the freeze did not work), so its numbers are still worked out live."));
        if (v.can_freeze) {
          var fb = btn("Freeze now", "primary"); st.appendChild(fb);
          fb.addEventListener("click", async function () {
            var ok = true; try { ok = await global.BPUI.confirm("Freeze today's numbers as this event's final P&L? It is marked \"Frozen by hand\" and can't be changed afterwards.", { title: "Freeze the P&L?", okLabel: "Freeze now" }); } catch (e) {}
            if (!ok) return; busy(fb, true, "Freezing…");
            try { await B.moneyLock.freezeNow(id); toast("P&L frozen."); changed(); } catch (e) { toast(errText(e), "err"); busy(fb, false); }
          });
        }
      }
      box.appendChild(st);
      // versions
      if ((v.versions || []).length) {
        box.appendChild(el("h3", null, "Versions"));
        var t = table([["Version", ""], ["What", ""], ["When", ""], ["Net profit", "num"], ["What changed", ""]], "Frozen P&L versions");
        v.versions.forEach(function (x) {
          var r = el("tr"); r.appendChild(td("v" + x.version + (x.current ? " (current)" : ""), null, "Version"));
          r.appendChild(td(REASON[x.reason] || x.reason, null, "What")); r.appendChild(td(niceDate(x.at) + (x.by ? " · " + x.by : ""), null, "When"));
          r.appendChild(moneyTd(x.net_profit, fmt, "Net profit"));
          var c = el("td", "mlk-diff"); c.setAttribute("data-label", "What changed"); var d = x.diff || {};
          if (!has(d.from_version)) c.appendChild(el("span", "mlk-muted", "first freeze"));
          else {
            var ch = num(d.net_profit && d.net_profit.change), line = el("div");
            line.appendChild(document.createTextNode("vs v" + d.from_version + ": profit "));
            line.appendChild(money(el("b", ch < 0 ? "neg" : null, (ch >= 0 ? "+" : "−") + fmt(Math.abs(ch))))); c.appendChild(line);
            (d.categories || []).slice(0, 6).forEach(function (k) {
              var li = el("div", "mlk-muted"); li.appendChild(document.createTextNode(CAT(k.key) + " cost "));
              li.appendChild(money(el("span", null, (num(k.change) >= 0 ? "+" : "−") + fmt(Math.abs(num(k.change)))))); c.appendChild(li);
            });
            if (d.reopen_reason) c.appendChild(el("div", "mlk-muted", "re-opened: " + d.reopen_reason));
          }
          if (x.note && x.reason !== "close") c.appendChild(el("div", "mlk-muted", x.note));
          r.appendChild(c); t.body.appendChild(r);
        });
        box.appendChild(t.wrap);
      }
      // corrections
      box.appendChild(el("h3", null, "Corrections"));
      box.appendChild(el("p", "mlk-hint", "A wrong number is never edited: add a correction (a plus or minus amount with the reason). It counts in the margin and stays on record."));
      if ((v.corrections || []).length) {
        var ct = table([["Date", ""], ["Category", ""], ["Amount", "num"], ["Reason", ""], ["By", ""]], "Cost corrections");
        v.corrections.forEach(function (x) {
          var r = el("tr"); r.appendChild(td(niceDate(x.on), null, "Date"));
          r.appendChild(td(CAT(x.category) + (x.after_close ? " · late adjustment" : ""), null, "Category"));
          r.appendChild(moneyTd(x.amount, fmt, "Amount")); r.appendChild(td(x.reason, null, "Reason")); r.appendChild(td(x.by || "", "mlk-muted", "By"));
          ct.body.appendChild(r);
        });
        box.appendChild(ct.wrap);
      } else box.appendChild(el("p", "mlk-muted", "No corrections."));
      if (v.can_correct) {
        var f = el("div", "mlk-form"), cats = (B.moneyLock.CORRECTION_CATS || []).map(function (c) { return [c[0], c[1]]; });
        var cs = select(cats, "misc"), am = input("text", "", { inputmode: "decimal", placeholder: "e.g. -2000 or 1500", maxlength: "16" }),
            rs = input("text", "", { maxlength: "500", placeholder: "e.g. generator bill typed twice" });
        f.appendChild(field("Category", cs)); f.appendChild(field("Amount (minus to take off)", am)); f.appendChild(field("Reason", rs));
        var ab = btn(v.closed ? "Add late adjustment" : "Add correction", "primary"); var aw = el("div", "mlk-fld mlk-act"); aw.appendChild(ab); f.appendChild(aw);
        if (v.closed) box.appendChild(el("p", "mlk-hint", "The event is closed: a late adjustment writes the next frozen version at once (admins only, as set in Settings → Money rules)."));
        box.appendChild(f);
        ab.addEventListener("click", async function () {
          var n = B.moneyLock.amount(am.value), why = rs.value.trim();
          if (!isFinite(n) || n === 0) { toast("Enter the amount to add, or a minus amount to take off.", "err"); am.focus(); return; }
          if (why.length < 5) { toast("Give a reason of at least 5 characters.", "err"); rs.focus(); return; }
          busy(ab, true);
          try { await B.moneyLock.addCorrection(id, cs.value, n, why); toast(v.closed ? "Late adjustment added - new frozen version written." : "Correction added."); changed(); }
          catch (e) { toast(errText(e), "err"); busy(ab, false); }
        });
      } else if (v.closed) box.appendChild(el("p", "mlk-muted", v.late_adjust === "admin" ? "Only an admin can add a late adjustment to a closed event." : "To correct a closed event, an admin re-opens it first (or allows late adjustments in Settings → Money rules)."));
    }
    function changed() { try { document.dispatchEvent(new CustomEvent("helm:pnl-refresh", { detail: { fromLock: true } })); } catch (_) {} draw(); }
    document.addEventListener("helm:pnl-refresh", function (e) { if (!(e && e.detail && e.detail.fromLock)) draw(); });
    await draw();
  }

  // ---------------- 2) Confirm attendance (Closure) ----------------
  function wageText(p, fmt) {
    if (!has(p.confirmed_wage) && !has(p.suggested_wage)) return null;
    return fmt(has(p.confirmed_wage) ? p.confirmed_wage : p.suggested_wage);
  }
  async function mountAttendance(box) {
    var B = S(), id = qid(); if (!id || !B || !B.moneyLock) { box.hidden = true; return; }
    var fin = false; try { fin = await B.auth.canView("finance"); } catch (e) { fin = false; }
    if (!fin) { box.hidden = true; return; }
    var fmt = await fmtFor(id);
    async function draw() {
      var a; try { a = await B.moneyLock.attendance(id); } catch (e) { a = null; }
      if (!a || !a.count) { box.hidden = true; return; }
      card(box, "🧑‍🤝‍🧑 Crew attendance & wages", "Confirm who worked and for how long, so the wages in the margin are final. Suggested from the crew link check-ins and the arrival list.");
      var r = a.rules || {}, rl = el("p", "mlk-hint");
      rl.textContent = "Half day: " + (r.half_day ? "on (0.5 = half the day rate)" : "off (a part day is paid as a full day)") + " · Overtime: " + (r.ot_enabled ? "on" : "off")
        + " · Allowance: " + (r.allowance_enabled ? "on" : "off") + " · Standard day " + num(r.std_hours) + " h. Change these in Settings → Money rules.";
      box.appendChild(rl);
      var sum = el("p", "mlk-sum"); sum.textContent = a.confirmed + " of " + a.count + " confirmed" + (a.not_marked ? " · " + a.not_marked + " not marked (no check-in or arrival) - enter their days" : "");
      box.appendChild(sum);
      var cols = [["Person", ""], ["Check-in / arrival", ""], ["Days worked", "num"]];
      var hourly = (a.people || []).some(function (p) { return p.pay_basis === "hours"; });
      if (hourly) cols.push(["Hours", "num"]);
      if (r.ot_enabled) cols.push(["Overtime h", "num"]);
      if (r.allowance_enabled) cols.push(["Allowance", "num"]);
      if (a.pay_visible) cols.push(["Wage", "num"]);
      cols.push(["Status", ""]);
      var t = table(cols, "Crew attendance"), edits = [];
      (a.people || []).forEach(function (p) {
        var s = p.suggested || {}, c = p.confirmed || null, base = c || s, tr = el("tr");
        tr.appendChild(td(p.name || "Crew member", "mlk-name", "Person"));
        var src = s.source === "checkin" ? ("checked in " + s.checkin_days + " day" + (s.checkin_days === 1 ? "" : "s") + (has(s.hours) ? " · " + s.hours + " h" : "") + (s.open_checkins ? " · still checked in" : ""))
                : s.source === "roster" ? (s.roster === "no_show" ? "no-show on the arrival list" : "arrived (arrival list)") : "not marked";
        tr.appendChild(td(src, "mlk-muted", "Check-in / arrival"));
        var row = { p: p, dirty: false };
        function cellInput(key, val, label, step) {
          var c2 = el("td", "num"); c2.setAttribute("data-label", label);
          var i = input("number", has(val) ? val : "", { min: "0", step: step || "0.5", inputmode: "decimal", "aria-label": label + " - " + (p.name || "") });
          i.className = "mlk-num"; i.disabled = !a.can_confirm;
          i.addEventListener("input", function () { row.dirty = true; saveBtn.disabled = false; });
          row[key] = i; c2.appendChild(i); tr.appendChild(c2);
        }
        cellInput("days", base.days, "Days worked");
        if (hourly) { if (p.pay_basis === "hours") cellInput("hours", base.hours, "Hours", "0.25"); else tr.appendChild(td("", null, "Hours")); }
        if (r.ot_enabled) cellInput("ot_hours", has(base.ot_hours) ? base.ot_hours : 0, "Overtime h");
        if (r.allowance_enabled) cellInput("allowance", has(base.allowance) ? base.allowance : (c ? 0 : s.allowance), "Allowance", "1");
        if (a.pay_visible) {
          var w = wageText(p, fmt), wc = el("td", "num"); wc.setAttribute("data-label", "Wage");
          if (p.rate_missing) wc.appendChild(el("span", "mlk-warn-t", "rate missing"));
          else if (w) wc.appendChild(money(el("span", null, w))); else wc.appendChild(el("span", "mlk-muted", "—"));
          tr.appendChild(wc);
        }
        tr.appendChild(td(c ? "✓ confirmed " + niceDate(c.at) + (c.by ? " · " + c.by.split("@")[0] : "") : s.source === "none" ? "not marked" : "suggested", c ? "mlk-ok" : "mlk-muted", "Status"));
        t.body.appendChild(tr); edits.push(row);
      });
      box.appendChild(t.wrap);
      var acts = el("div", "mlk-actions"), oneTap = btn("Confirm attendance (as suggested)", "primary"), saveBtn = btn("Save changes");
      saveBtn.disabled = true;
      if (a.can_confirm) { acts.appendChild(oneTap); acts.appendChild(saveBtn); box.appendChild(acts); }
      else box.appendChild(el("p", "mlk-muted", a.closed ? "The event is closed - re-open it to change attendance." : "Only someone allowed to edit Budget & finance can confirm attendance."));
      if (!a.pay_visible) box.appendChild(el("p", "mlk-hint", "Per-person pay is visible to the studio admin only; the margin counts it."));
      oneTap.addEventListener("click", async function () {
        busy(oneTap, true, "Confirming…");
        try { var res = await B.moneyLock.confirmAttendance(id, null); toast(res && res.written ? res.written + " confirmed." : "Everyone marked is already confirmed."); changed(); }
        catch (e) { toast(errText(e), "err"); busy(oneTap, false); }
      });
      saveBtn.addEventListener("click", async function () {
        var rows = [], bad = null;
        edits.filter(function (x) { return x.dirty; }).forEach(function (x) {
          var o = B.moneyLock.attendanceRow(x.p.crew_id, x.days.value, { ot_hours: x.ot_hours && x.ot_hours.value, allowance: x.allowance && x.allowance.value, hours: x.hours && x.hours.value });
          if (o.error) { bad = bad || { msg: o.error + " (" + (x.p.name || "") + ")", focus: x.days }; } else rows.push(o);
        });
        if (bad) { toast(bad.msg, "err"); try { bad.focus.focus(); } catch (_) {} return; }
        if (!rows.length) return;
        busy(saveBtn, true);
        try { await B.moneyLock.confirmAttendance(id, rows); toast(rows.length + " saved."); changed(); }
        catch (e) { toast(errText(e), "err"); busy(saveBtn, false); }
      });
    }
    function changed() { try { document.dispatchEvent(new CustomEvent("helm:pnl-refresh", { detail: { fromAttendance: true } })); } catch (_) {} draw(); }
    await draw();
  }

  // ---------------- 3) client TDS (Settlement) ----------------
  async function mountTds(box) {
    var B = S(), id = qid(); if (!id || !B || !B.moneyLock) { box.hidden = true; return; }
    var fin = false; try { fin = await B.auth.canView("finance"); } catch (e) { fin = false; }
    if (!fin) { box.hidden = true; return; }
    var fmt = await fmtFor(id);
    async function draw() {
      var d; try { d = await B.moneyLock.tds(id); } catch (e) { d = null; }
      if (!d || (!d.enabled && !(d.rows || []).length)) { box.hidden = true; return; }
      card(box, "🧾 TDS deducted by the client", "A company client often pays 98% and keeps 2% as TDS (e.g. section 194C). Record it here: it counts as received for the balance and for closing, and is \"TDS receivable\" until the Form 16A comes in. It does not change profit.");
      var tiles = el("div", "mlk-tiles");
      [["TDS recorded", d.total], ["Form 16A received", d.certified], ["Still to receive (Form 16A)", Math.max(num(d.total) - num(d.certified), 0)], ["Balance owed after TDS", d.balance_owed]].forEach(function (x) {
        var c = el("div", "mlk-tile"); c.appendChild(el("span", null, x[0])); c.appendChild(money(el("b", null, fmt(x[1])))); tiles.appendChild(c);
      });
      box.appendChild(tiles);
      var rows = (d.rows || []);
      if (rows.length) {
        var t = table([["Date", ""], ["Section", ""], ["Amount", "num"], ["Form 16A", ""], ["", ""]], "Client TDS entries");
        rows.forEach(function (x) {
          var tr = el("tr"); tr.appendChild(td(niceDate(x.on), null, "Date")); tr.appendChild(td(x.section || "—", null, "Section"));
          tr.appendChild(moneyTd(x.amount, fmt, "Amount"));
          var fc = el("td"); fc.setAttribute("data-label", "Form 16A");
          if (num(x.amount) < 0) fc.appendChild(el("span", "mlk-muted", x.note || "reversal"));
          else if (x.reversed) fc.appendChild(el("span", "mlk-muted", "reversed"));
          else if (x.form16a) fc.appendChild(el("span", "mlk-ok", "✓ received " + niceDate(x.form16a.received_on)));
          else if (d.can_edit) {
            var fb = btn("Form 16A received"); fc.appendChild(fb);
            fb.addEventListener("click", async function () { busy(fb, true); try { await B.moneyLock.form16a(x.id, null, null); toast("Form 16A marked as received."); after(); } catch (e) { toast(errText(e), "err"); busy(fb, false); } });
          } else fc.appendChild(el("span", "mlk-muted", "waiting"));
          tr.appendChild(fc);
          var ac = el("td");
          if (d.can_edit && !d.closed && num(x.amount) > 0 && !x.reversed) {
            var rb = btn("Reverse", "mlk-link"); ac.appendChild(rb);
            rb.setAttribute("aria-label", "Reverse TDS of " + fmt(x.amount));
            rb.addEventListener("click", async function () {
              var why = null; try { why = await global.BPUI.prompt("A minus row cancels this TDS entry (nothing is deleted). Why?", { title: "Reverse this TDS?", label: "Reason (5 to 300 characters)", required: true, okLabel: "Reverse" }); } catch (e) { why = null; }
              if (!why) return; busy(rb, true);
              try { await B.moneyLock.reverseTds(x.id, why); toast("TDS entry reversed."); after(); } catch (e) { toast(errText(e), "err"); busy(rb, false); }
            });
          }
          tr.appendChild(ac); t.body.appendChild(tr);
        });
        box.appendChild(t.wrap);
      }
      if (d.can_edit && d.enabled && num(d.balance_owed) > 0) {
        var f = el("div", "mlk-form"), sug = Math.min(num(d.suggested), num(d.balance_owed));
        var am = input("number", sug > 0 ? sug : "", { min: "0", step: "1", inputmode: "decimal" }), sec = input("text", d.default_section || "194C", { maxlength: "7", autocapitalize: "characters" }),
            nt = input("text", "", { maxlength: "300", placeholder: "optional, e.g. client name / invoice" });
        f.appendChild(field("TDS amount", am, "Suggested " + num(d.default_rate) + "% of the invoice without GST.")); f.appendChild(field("Section", sec)); f.appendChild(field("Note", nt));
        var sb = btn("Record TDS", "primary"), aw = el("div", "mlk-fld mlk-act"); aw.appendChild(sb); f.appendChild(aw); box.appendChild(f);
        sb.addEventListener("click", async function () {
          var n = Number(am.value); if (!isFinite(n) || n <= 0) { toast("Enter the TDS amount the client deducted.", "err"); am.focus(); return; }
          busy(sb, true);
          try { await B.moneyLock.recordTds(id, n, sec.value.trim(), d.default_rate, nt.value.trim()); toast("TDS recorded - it counts as received."); after(); }
          catch (e) { toast(errText(e), "err"); busy(sb, false); }
        });
      }
    }
    function after() { try { document.dispatchEvent(new CustomEvent("helm:tds-changed")); } catch (_) {} draw(); }
    document.addEventListener("helm:settlement-loaded", function () { draw(); });
    await draw();
  }

  // ---------------- 4) GST and TDS by month (Business) ----------------
  function ymd(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
  async function mountBusiness(box) {
    var B = S(); if (!B || !B.moneyLock) { box.hidden = true; return; }
    var d = new Date(), from = new Date(d.getFullYear(), d.getMonth() - 11, 1), to = new Date(d.getFullYear(), d.getMonth() + 13, 0), t;
    try { t = await B.moneyLock.taxByMonth(ymd(from), ymd(to)); } catch (e) { t = null; }
    if (!t) { box.hidden = true; return; }
    var cfg = null; try { cfg = await B.moneyLock.settings(); } catch (e) { cfg = null; }
    clear(box); box.hidden = false; box.classList.add("bz-card", "mlk-biz");
    var hd = el("div", "bz-head"); hd.appendChild(el("h3", null, "GST & TDS by month")); box.appendChild(hd);
    box.appendChild(el("p", "mlk-hint", "GST collected minus GST on refunds minus input credit on vendor bills = GST to pay (by event month). Client TDS by the day it was recorded. An estimate for your accountant, not a GST return."));
    var months = (t.months || []).filter(function (m) { return num(m.gst_collected) || num(m.tds_deducted) || num(m.vendor_tds) || num(m.input_credit); });
    if (!months.length) { box.appendChild(el("p", "mlk-muted", "No GST or TDS in the last 12 months or the next 12 yet.")); }
    else {
      var tb = table([["Month", ""], ["GST collected", "num"], ["Input credit", "num"], ["GST to pay", "num"], ["Client TDS", "num"], ["Form 16A pending", "num"], ["Vendor TDS (info)", "num"]], "GST and TDS by month");
      months.forEach(function (m) {
        var tr = el("tr"), dt = new Date(m.month + "-01T00:00:00");
        tr.appendChild(td(dt.toLocaleDateString(undefined, { month: "short", year: "numeric" }), "mlk-name", "Month"));
        tr.appendChild(moneyTd(num(m.gst_collected) - num(m.gst_refunds), studioFmt, "GST collected"));
        tr.appendChild(moneyTd(m.input_credit, studioFmt, "Input credit")); tr.appendChild(moneyTd(m.gst_to_pay, studioFmt, "GST to pay", "mlk-strong"));
        tr.appendChild(moneyTd(m.tds_deducted, studioFmt, "Client TDS")); tr.appendChild(moneyTd(m.tds_pending, studioFmt, "Form 16A pending"));
        tr.appendChild(moneyTd(m.vendor_tds, studioFmt, "Vendor TDS (info)"));
        tb.body.appendChild(tr);
      });
      box.appendChild(tb.wrap);
    }
    if (num(t.other_currency_events)) box.appendChild(el("p", "mlk-muted", t.other_currency_events + " event(s) in another currency are not included."));
    if (cfg) box.appendChild(el("p", "mlk-muted", "Cancelled events " + (cfg.cancelled_in_pnl ? "are" : "are not") + " counted in the monthly profit above (money kept minus money already paid out) - Settings → Money rules."));
  }

  // ---------------- 5) money rules (Settings) ----------------
  async function mountSettings(box) {
    var B = S(); if (!B || !B.moneyLock || !B.auth || !B.auth.user || !B.auth.user()) { box.hidden = true; return; }
    var c; try { c = await B.moneyLock.settings(); } catch (e) { c = null; }
    if (!c) { box.hidden = true; return; }
    clear(box); box.hidden = false; box.classList.add("card", "mlk-card");
    box.appendChild(el("h3", null, "Money rules"));
    box.appendChild(el("p", "mnote", "How Helm counts wages, client TDS, cancelled events and closed events in the margin. The defaults keep the numbers as they were; ask your accountant before changing tax settings."));
    if (!c.can_edit) box.appendChild(el("p", "mnote", "Read-only: only a studio admin (or someone allowed to edit Settings) can change these."));
    var form = el("div", "mlk-set"), ctl = {};
    function group(title) { var g = el("fieldset", "mlk-group"); g.appendChild(el("legend", null, title)); form.appendChild(g); return g; }
    function chk(g, key, label) { var x = check(label, c[key]); x.box.disabled = !c.can_edit; ctl[key] = { get: function () { return x.box.checked; } }; g.appendChild(x.wrap); return x; }
    function nf(g, key, label, attrs, hint, nullable) {
      var i = input("number", has(c[key]) ? c[key] : "", attrs); i.disabled = !c.can_edit;
      ctl[key] = { get: function () { var t = String(i.value).trim(); if (t === "") return nullable ? null : undefined; var n = Number(t); return isFinite(n) ? n : NaN; } };
      g.appendChild(field(label, i, hint));
    }
    var g1 = group("Crew wages");
    chk(g1, "half_day", "Pay half days (0.5 day = half the day rate). Off: a part day is paid as a full day.");
    chk(g1, "ot_enabled", "Pay overtime after the standard day");
    var om = select([["multiplier", "× the hourly rate (day rate ÷ standard hours)"], ["per_hour", "A fixed amount per hour"]], c.ot_mode); om.disabled = !c.can_edit;
    ctl.ot_mode = { get: function () { return om.value; } }; g1.appendChild(field("Overtime rate", om));
    nf(g1, "ot_multiplier", "Overtime multiplier", { min: "1", max: "5", step: "0.1", inputmode: "decimal" }, "e.g. 1.5");
    nf(g1, "ot_rate", "Overtime per hour", { min: "0", step: "1", inputmode: "decimal" }, "Used when the rate is a fixed amount per hour.", true);
    var sh = input("number", has(c.std_hours_set) ? c.std_hours_set : "", { min: "1", max: "24", step: "0.5", inputmode: "decimal", placeholder: String(c.std_hours || 8) }); sh.disabled = !c.can_edit;
    ctl.std_hours = { get: function () { var t = String(sh.value).trim(); if (t === "") return null; var n = Number(t); return isFinite(n) ? n : NaN; } };
    g1.appendChild(field("Standard day (hours)", sh, "Empty = the day hours set for Crew (now " + (c.std_hours || 8) + ")."));
    chk(g1, "allowance_enabled", "Pay a food / travel allowance");
    nf(g1, "allowance_default", "Allowance per day", { min: "0", step: "1", inputmode: "decimal" }, "Suggested on Confirm attendance; can be changed per person.");
    var g2 = group("Client TDS");
    chk(g2, "tds_enabled", "Show \"TDS deducted by the client\" on Settlement");
    nf(g2, "tds_rate", "Suggested TDS %", { min: "0", max: "30", step: "0.5", inputmode: "decimal" });
    var ts = input("text", c.tds_section || "194C", { maxlength: "7" }); ts.disabled = !c.can_edit; ctl.tds_section = { get: function () { return ts.value.trim().toUpperCase(); } };
    g2.appendChild(field("Suggested section", ts));
    var g3 = group("Margin checks");
    nf(g3, "gap_pct", "Flag a cost category more than this % over the plan", { min: "0", max: "1000", step: "1", inputmode: "decimal" });
    nf(g3, "gap_abs", "… or more than this amount over the plan", { min: "0", step: "500", inputmode: "decimal" });
    chk(g3, "unplanned_tag", "Tag costs added on or after the event day with no estimate as \"Unplanned\"");
    var g4 = group("Closed and cancelled events");
    chk(g4, "freeze_closed", "Use the frozen P&L for closed events (Business, Settlement, reports)");
    var la = select([["reopen", "Re-open the event first (as today)"], ["admin", "An admin may add a late adjustment (writes a new frozen version)"]], c.late_adjust); la.disabled = !c.can_edit;
    ctl.late_adjust = { get: function () { return la.value; } }; g4.appendChild(field("A cost found after closing", la));
    chk(g4, "cancelled_in_pnl", "Count cancelled events in the monthly profit (money kept minus money already paid out)");
    box.appendChild(form);
    var msg = el("div", null); msg.setAttribute("role", "status"); msg.setAttribute("aria-live", "polite"); box.appendChild(msg);
    if (c.can_edit) {
      var acts = el("div", "actions"), sv = btn("Save money rules", "primary"); acts.appendChild(sv); box.appendChild(acts);
      sv.addEventListener("click", async function () {
        var patch = {}, bad = null;
        Object.keys(ctl).forEach(function (k) { var v = ctl[k].get(); if (v === undefined) return; if (typeof v === "number" && isNaN(v)) bad = bad || k; else patch[k] = v; });
        if (bad) { msg.className = "msg err"; msg.textContent = "Check the numbers - one of them is not a number."; return; }
        busy(sv, true); msg.className = "msg info"; msg.textContent = "Saving…";
        try { c = await B.moneyLock.saveSettings(patch) || c; msg.className = "msg ok"; msg.textContent = "Saved. The new rules apply to open events; closed events keep their frozen numbers."; }
        catch (e) { msg.className = "msg err"; msg.textContent = errText(e); }
        finally { busy(sv, false); }
      });
    }
  }

  // ---------------- self-mount ----------------
  var MOUNTS = { frozen: mountFrozen, attendance: mountAttendance, tds: mountTds, business: mountBusiness, settings: mountSettings };
  function whenShown(gate, fn) {
    if (!gate) { fn(); return; }
    var done = false, run = function () { if (done || gate.hidden) return; done = true; obs.disconnect(); fn(); };
    var obs = new MutationObserver(run); obs.observe(gate, { attributes: true, attributeFilter: ["hidden"] }); run();
  }
  function start() {
    Array.prototype.forEach.call(document.querySelectorAll("[data-mlk-mount]"), function (n) {
      var fn = MOUNTS[n.getAttribute("data-mlk-mount")]; if (!fn) return;
      var gid = n.getAttribute("data-mlk-gate"), gate = gid === "none" ? null : document.getElementById(gid || "app");
      var go = function () { Promise.resolve().then(function () { return fn(n); }).catch(function (e) { try { console.warn("money lock:", e && e.message); } catch (_) {} n.hidden = true; }); };
      if (n.getAttribute("data-mlk-mount") === "settings") {
        // Settings: wait until the store has a signed-in user (the page boots it)
        var tries = 0, wait = function () { var B = S(); if (B && B.auth && B.auth.user && B.auth.user()) go(); else if (++tries < 30) setTimeout(wait, 1000); };
        setTimeout(wait, 400); return;
      }
      whenShown(gate, go);
    });
  }
  global.HelmMoneyLock = { mountFrozen: mountFrozen, mountAttendance: mountAttendance, mountTds: mountTds, mountBusiness: mountBusiness, mountSettings: mountSettings };
  if (typeof document === "undefined") return;
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})(typeof window !== "undefined" ? window : globalThis);
