/* vendor-bills-ui.js - Phase C (0124): vendor bills + payouts (Settlement), per-event P&L card
   (Closure, Budget) and payables / net profit by month / top events (Business).
   Self-mounting: any element with data-vb-mount="bills" | "pnl" | "business" is filled once the
   page's own #app (or #bzApp) is shown, i.e. after the page has checked sign-in and access.
   DOM is built with createElement/textContent only (no HTML strings). Every amount has data-money
   so privacy mode masks it. Bills are never deleted: a wrong bill is voided with a reason. */
(function () {
  "use strict";
  var S = function () { return window.BPStore; };
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; }
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); }
  function money(node) { node.setAttribute("data-money", ""); return node; }
  function qid() { var p = new URLSearchParams(location.search); return p.get("quote") || p.get("id") || ""; }
  function ymd(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
  // r37: the STUDIO's day (bill dates, overdue, "this month"), the device day only without a studio store
  function today() { try { var B = typeof window !== "undefined" ? window.BPStore : null, t = B && B.todayLocal ? B.todayLocal() : ""; if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t; } catch (e) {} var d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
  function key() { try { if (self.crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (e) {} return String(Date.now()) + "-" + Math.random().toString(16).slice(2); }
  function errText(e) { return (e && e.message) ? String(e.message).slice(0, 240) : "Something went wrong - try again."; }
  function missingNote(box, what) {
    var n = el("div", "vb-note");
    n.appendChild(el("b", null, what + " turn on after database update 0124. "));
    n.appendChild(document.createTextNode("Ask your admin to run APPLY-0124.sql (nothing existing is changed)."));
    box.appendChild(n);
  }
  function field(label, input) { var f = el("label", "vb-fld"); f.appendChild(el("span", null, label)); f.appendChild(input); return f; }
  function inp(type, ph) { var i = el("input"); i.type = type; if (ph) i.placeholder = ph; return i; }
  var STATE_LABEL = { paid: "Paid", part: "Part paid", unpaid: "Unpaid", overdue: "Overdue", void: "Void" };

  // ---------------- money formatter per page ----------------
  async function fmtFor(quoteId) {
    var B = S(), cfg = null;
    if (quoteId) { try { var ev = await B.quotes.get(quoteId); cfg = ev ? B.quoteTax(ev) : null; } catch (e) { cfg = null; } }
    return function (n) { try { return cfg ? B.quoteMoney(n, cfg) : B.studioMoney(n); } catch (e) { return String(Math.round(Number(n) || 0)); } };
  }

  // ---------------- Settlement: Vendor bills ----------------
  /* R190 (0373): TDS off the payout (its own payout row, the bill counts as settled), cash-limit warning, photo / PDF
     added later, typed advances turned into payout rows, the GST 150-day warning and a "late bill" form once the event
     is closed. All of it needs the 0373 extras (B.vendorBills.extra); a server without 0373 keeps the older card. */
  function tdsOf(b) { return (b.vendor_payouts || []).filter(function (p) { return p && p.source === "tds"; }).reduce(function (a, p) { return a + Number(p.amount || 0); }, 0); }
  async function mountBills(box) {
    var B = S(), id = qid(); if (!id) return;
    var fmt = await fmtFor(id), canEdit = false;
    try { canEdit = await B.auth.canEditArea("finance"); } catch (e) { canEdit = false; }
    clear(box); box.classList.add("card", "vb-card"); box.id = box.id || "vendorBills";
    box.appendChild(el("h2", null, "🧾 Vendor bills"));
    box.appendChild(el("p", "sub", "Bills your vendors sent for this event, and what you've paid them. Once a booking has bills, the bills replace its booked cost in the profit."));
    var sum = el("div", "vb-sum"), msg = el("div", "vb-msg"); msg.setAttribute("role", "status"); msg.setAttribute("aria-live", "polite");
    var adv = el("div", "vb-adv"), list = el("div", "vb-list"), formBox = el("div", "vb-form");
    box.appendChild(sum); box.appendChild(adv); box.appendChild(list); box.appendChild(formBox); box.appendChild(msg);
    var bookings = [];
    try { bookings = (await B.bookings.list(id)).filter(function (b) { return b.status !== "cancelled"; }); } catch (e) { bookings = []; }
    var ex = null, exBill = {};

    async function reload() {
      clear(list); clear(sum); list.appendChild(el("p", "vb-muted", "Loading…"));
      var bills;
      try { bills = await B.vendorBills.list(id); }
      catch (e) {
        clear(list); clear(formBox);
        if (e && e.code === "vendor_bills_missing") { missingNote(list, "Vendor bills"); return; }
        list.appendChild(el("p", "vb-err", "Couldn't load vendor bills: " + errText(e))); return;
      }
      try { ex = B.vendorBills.extra ? await B.vendorBills.extra(id) : null; } catch (e) { ex = null; }
      exBill = {}; ((ex && ex.bills) || []).forEach(function (x) { exBill[x.id] = x; });
      fig = B.vendorBills.settle(bookings, bills, today()).byBill;   // same rule as the vendor table: advance counts toward the bill
      renderSummary(bills); renderAdvances(); renderList(bills); renderForm();
      try { document.dispatchEvent(new CustomEvent("helm:vendor-bills-changed")); } catch (e) {}
    }
    var fig = {};
    function paidOf(b) { var f = fig[b.id]; return f ? f.paid : (b.vendor_payouts || []).reduce(function (a, p) { return a + Number(p.amount || 0); }, 0); }
    function stateOf(b, t) { var f = fig[b.id]; return f && f.state ? f.state : B.vendorBills.state(b, t); }
    function renderSummary(bills) {
      var t = today(), live = bills.filter(function (b) { return b.status !== "void"; });
      var billed = 0, paid = 0, over = 0;
      live.forEach(function (b) { var p = paidOf(b); billed += Number(b.amount || 0); paid += p; if (stateOf(b, t) === "overdue") over += Number(b.amount || 0) - p; });
      [["Billed", billed, ""], ["Paid", paid, "ok"], ["Unpaid", billed - paid, billed - paid > 0 ? "due" : ""], ["Overdue", over, over > 0 ? "over" : ""]].forEach(function (x) {
        var c = el("div", "vb-chip " + x[2]); c.appendChild(el("span", null, x[0])); c.appendChild(money(el("b", null, fmt(x[1])))); sum.appendChild(c);
      });
    }
    // R190: typed advances (old bookings) that are not payout rows yet -> one button turns them into payouts (added rows only)
    function renderAdvances() {
      clear(adv); if (!ex || !canEdit) return;
      var conv = (ex.bookings || []).filter(function (x) { return x.convertible; });
      if (!conv.length) return;
      var total = conv.reduce(function (a, x) { return a + Number(x.left || 0); }, 0);
      var n = el("div", "vb-note");
      n.appendChild(el("b", null, "Typed advances not recorded as payments yet. "));
      n.appendChild(document.createTextNode("These vendor bookings have an advance typed on the booking ("));
      n.appendChild(money(el("span", null, fmt(total))));
      n.appendChild(document.createTextNode("). Turn them into payments on their bills, so the bills show the right balance. The typed advance is kept as it is."));
      var go = el("button", "btn", "Record as payments"); go.type = "button";
      go.addEventListener("click", async function () {
        go.disabled = true; msg.textContent = "Saving…";
        try { var r = await B.vendorBills.convertAdvances(id); msg.textContent = (r && r.rows) ? "Recorded " + r.rows + " payment" + (r.rows === 1 ? "" : "s") + " from typed advances." : "Nothing to record."; await reload(); }
        catch (e) { go.disabled = false; msg.textContent = errText(e); }
      });
      n.appendChild(el("br")); n.appendChild(go); adv.appendChild(n);
    }
    function bookingLabel(bid) { var b = bookings.find(function (x) { return x.id === bid; }); return b ? (b.label || "Vendor booking") : ""; }
    async function openFile(fileId) {
      // open the tab inside the click (popup blockers allow it), then point it at the signed link
      var w = null; try { w = window.open("", "_blank"); if (w) w.opener = null; } catch (e) { w = null; }
      try { var fl = await B.files.list(id); var f = (fl || []).find(function (x) { return x.id === fileId; });
        if (!f) throw new Error("The file is no longer there.");
        var u = await B.files.signedUrl(f.storage_path, 120); if (!u) throw new Error("Couldn't open the file - try again.");
        if (w) w.location.href = u; else window.open(u, "_blank", "noopener"); }
      catch (e) { if (w) { try { w.close(); } catch (_) {} } msg.textContent = errText(e); }
    }
    function renderList(bills) {
      clear(list);
      if (!bills.length) { list.appendChild(el("p", "vb-muted", canEdit ? "No vendor bills yet. Add the first one below - a photo from WhatsApp is enough." : "No vendor bills yet.")); return; }
      var wrap = el("div", "table-scroll"), tb = el("table", "vb-table"), th = el("thead"), hr = el("tr");
      ["Bill", "Date", "Due", "Amount", "Paid", "Status", ""].forEach(function (h, i) { var c = el("th", i === 3 || i === 4 ? "num" : null, h); c.scope = "col"; hr.appendChild(c); });
      th.appendChild(hr); tb.appendChild(th); var body = el("tbody"); tb.appendChild(body); wrap.appendChild(tb); list.appendChild(wrap);
      var t = today();
      bills.forEach(function (b) {
        var st = stateOf(b, t), paid = paidOf(b), f = fig[b.id], x = exBill[b.id] || null, tr = el("tr", st === "void" ? "vb-void" : null);
        var c1 = el("td"); c1.appendChild(el("b", null, b.bill_no ? "#" + b.bill_no : "Bill"));
        var sub = [bookingLabel(b.booking_id), b.description].filter(Boolean).join(" · ");
        if (sub) c1.appendChild(el("div", "vb-muted", sub));
        if (st === "void" && b.void_reason) c1.appendChild(el("div", "vb-muted", "Void: " + b.void_reason));
        if (x && x.late) c1.appendChild(el("div", "vb-muted", "Added after the event closed: " + x.late.reason));
        tr.appendChild(c1); tr.appendChild(el("td", null, b.bill_date || "")); tr.appendChild(el("td", null, b.due_date || "—"));
        // mask the amount, not the cell: on phones the cell carries its column label (Amount / Paid)
        var ca = el("td", "num"); ca.appendChild(money(el("span", null, fmt(b.amount))));
        if (b.gst_amount != null && Number(b.gst_amount) > 0) {   // r21 money (0246)
          var gl = el("div", "vb-muted"); gl.appendChild(document.createTextNode("incl. GST ")); gl.appendChild(money(el("span", null, fmt(b.gst_amount))));
          if (b.gst_claimable === false) gl.appendChild(document.createTextNode(" (not claimable)")); ca.appendChild(gl);
        }
        tr.appendChild(ca);
        var cp = el("td", "num"); cp.appendChild(money(el("span", null, fmt(paid))));
        if (f && f.advance > 0) {   // e.g. ₹18,000 (₹5,000 advance + ₹13,000 payouts)
          var br = el("div", "vb-muted"); br.appendChild(document.createTextNode("("));
          br.appendChild(money(el("span", null, fmt(f.advance)))); br.appendChild(document.createTextNode(" advance + "));
          br.appendChild(money(el("span", null, fmt(f.payouts)))); br.appendChild(document.createTextNode(" payouts)"));
          cp.appendChild(br);
        }
        var tds = tdsOf(b);
        if (tds > 0) { var tl = el("div", "vb-muted"); tl.appendChild(document.createTextNode("incl. TDS ")); tl.appendChild(money(el("span", null, fmt(tds)))); cp.appendChild(tl); }
        tr.appendChild(cp);
        var sc = el("td"); sc.appendChild(el("span", "vb-st " + st, STATE_LABEL[st] || st));
        if (x && x.gst_warn && st !== "paid" && st !== "void") {
          var gw = el("div", "vb-warn", "GST credit: pay before " + (x.gst_deadline || "day 180") + " or the credit must be reversed");
          gw.title = "An unpaid bill loses its GST input credit 180 days after the bill date."; sc.appendChild(gw);
        }
        if (x && Number(x.reminders) > 0) sc.appendChild(el("div", "vb-muted", "Reminded " + x.reminders + "×"));
        tr.appendChild(sc);
        var act = el("td", "vb-act");
        var fileId = b.file_id || (x && x.files && x.files.length ? x.files[x.files.length - 1].file_id : null);
        if (fileId) {
          var vf = el("button", "btn", "View file"); vf.type = "button";
          vf.addEventListener("click", function () { openFile(fileId); });
          act.appendChild(vf);
        } else if (canEdit && ex && st !== "void") {
          var af = el("button", "btn", "Add photo / PDF"); af.type = "button"; af.title = "Add the bill's photo or PDF (the bill itself is not changed)";
          af.addEventListener("click", function () { openAttach(tr, b); }); act.appendChild(af);
        }
        if (canEdit && st !== "void" && st !== "paid") {
          var pb = el("button", "btn go", "Record payout"); pb.type = "button";
          pb.addEventListener("click", function () { openPay(tr, b, Number(b.amount || 0) - paid, x); }); act.appendChild(pb);
        }
        if (canEdit && st !== "void" && !(f ? f.payouts : paid)) {
          var vb = el("button", "rm", "Void"); vb.type = "button"; vb.title = "Void this bill (it is kept, with the reason)";
          vb.addEventListener("click", function () { openVoid(tr, b); }); act.appendChild(vb);
        }
        tr.appendChild(act); body.appendChild(tr);
      });
    }
    function inlineRow(tr) {
      var nx = tr.nextSibling; if (nx && nx.classList && nx.classList.contains("vb-inline")) { nx.parentNode.removeChild(nx); return null; }
      var r = el("tr", "vb-inline"), td = el("td"); td.colSpan = 7; r.appendChild(td); tr.parentNode.insertBefore(r, tr.nextSibling); return td;
    }
    function openPay(tr, b, left, x) {
      var td = inlineRow(tr); if (!td) return;
      var k = key();                                              // one key per payout attempt (retries reuse it)
      var withTds = !!(ex && B.vendorBills.payTds);              // R190: TDS + cash warning need 0373
      var sug = withTds && x && x.tds_suggest && Number(x.tds_suggest.amount) > 0 && Number(x.tds_suggest.amount) < left ? x.tds_suggest : null;
      var amt = inp("number"); amt.min = "0"; amt.step = "0.01"; amt.value = String(Math.round((left - (sug ? Number(sug.amount) : 0)) * 100) / 100);
      var dt = inp("date"); dt.value = today(); dt.max = today();
      var how = el("select"); ["Bank transfer", "UPI", "Cash", "Cheque", "Card", "Other"].forEach(function (m) { var o = el("option", null, m); o.value = m; how.appendChild(o); });
      var ref = inp("text", "UTR / cheque no. (optional)"); ref.maxLength = 120;
      var go = el("button", "btn primary", "Save payout"); go.type = "button";
      var row = el("div", "vb-grid"); row.appendChild(field("Amount paid (left " + fmt(left) + ")", amt)); row.appendChild(field("Paid on", dt));
      row.appendChild(field("How", how)); row.appendChild(field("Reference", ref));
      var tdsIn = null, secIn = null, amtTouched = false;
      if (withTds) {
        tdsIn = inp("number", "0"); tdsIn.min = "0"; tdsIn.step = "0.01"; tdsIn.value = sug ? String(sug.amount) : "";
        secIn = inp("text", "e.g. 194C"); secIn.maxLength = 8; secIn.value = sug ? String(sug.section || "") : "";
        var ft = field("TDS deducted (optional)", tdsIn); ft.title = "Tax you keep back and pay to the government. It counts toward the bill, so the bill is fully settled.";
        row.appendChild(ft); row.appendChild(field("TDS section", secIn));
        amt.addEventListener("input", function () { amtTouched = true; });
        tdsIn.addEventListener("input", function () { if (amtTouched) return; var tv = Number(tdsIn.value) || 0; amt.value = String(Math.max(0, Math.round((left - tv) * 100) / 100)); });
      }
      var g = el("div", "vb-fld"); g.appendChild(go); row.appendChild(g); td.appendChild(row);
      if (sug) td.appendChild(el("p", "vb-muted", "TDS suggested " + (sug.from === "invoice" ? "from the vendor's invoice" : "from your studio default") + " (" + sug.section + "). Change or clear it if you don't deduct TDS."));
      var cashNote = el("p", "vb-warn"); cashNote.hidden = true; td.appendChild(cashNote);
      function cashCheck() {
        var lim = ex && ex.cash_limit != null ? Number(ex.cash_limit) : 0, a = Number(amt.value) || 0;
        var on = withTds && how.value === "Cash" && lim > 0 && a > lim;
        cashNote.hidden = !on; cashNote.textContent = on ? "Cash over " + fmt(lim) + " to one vendor in a day may not count as a business expense (Section 40A(3)). Pay by bank or UPI if you can - you can still save it." : "";
      }
      how.addEventListener("change", cashCheck); amt.addEventListener("input", cashCheck);
      // dev pass 3: payout errors show right here, next to the payout amount (not under the Add-bill form)
      var pmsg = el("p", "vb-err"); pmsg.setAttribute("role", "alert"); pmsg.hidden = true; td.appendChild(pmsg);
      function perr(t) { pmsg.textContent = t; pmsg.hidden = !t; if (t) amt.setAttribute("aria-invalid", "true"); else amt.removeAttribute("aria-invalid"); }
      go.addEventListener("click", async function () {
        var a = Number(amt.value || 0), tv = tdsIn ? Number(tdsIn.value || 0) : 0, sec = secIn ? String(secIn.value || "").trim().toUpperCase() : "";
        if (!(a >= 0) || !(tv >= 0) || !(a + tv > 0)) { perr("Enter an amount above zero."); amt.focus(); return; }
        if (a + tv > left + 0.005) { perr("That's more than the " + fmt(left) + " left on this bill."); amt.focus(); return; }
        if (tv > 0 && !/^19[0-9][A-Z]{0,3}$/.test(sec)) { perr("Give the TDS section (for example 194C)."); secIn.focus(); return; }
        perr(""); go.disabled = true; msg.textContent = "Saving…";
        try {
          var r = withTds ? await B.vendorBills.payTds(b.id, a, tv, tv > 0 ? sec : null, dt.value, how.value, ref.value, k)
                          : await B.vendorBills.pay(b.id, a, dt.value, how.value, ref.value, k);
          var w = r && Array.isArray(r.warnings) && r.warnings.length ? " " + r.warnings.map(function (x2) { return x2 && x2.text; }).filter(Boolean).join(" ") : "";
          msg.textContent = (r && r.duplicate ? "Already recorded." : (tv > 0 ? "Payout + TDS recorded." : "Payout recorded.")) + w; await reload(); }
        catch (e) { go.disabled = false; msg.textContent = ""; perr(errText(e)); }
      });
    }
    function openAttach(tr, b) {
      var td = inlineRow(tr); if (!td) return;
      var fl = inp("file"); fl.accept = "image/png,image/jpeg,image/webp,application/pdf";
      var go = el("button", "btn primary", "Add file"); go.type = "button";
      var row = el("div", "vb-grid"); row.appendChild(field("Photo / PDF of the bill", fl)); var g = el("div", "vb-fld"); g.appendChild(go); row.appendChild(g); td.appendChild(row);
      go.addEventListener("click", async function () {
        var file = fl.files && fl.files[0] ? fl.files[0] : null;
        if (!file) { msg.textContent = "Choose the photo or PDF of the bill."; return; }
        go.disabled = true; msg.textContent = "Uploading…";
        try { await B.vendorBills.attach(id, b.id, file); msg.textContent = "File added to the bill."; await reload(); }
        catch (e) { go.disabled = false; msg.textContent = errText(e); }
      });
    }
    function openVoid(tr, b) {
      var td = inlineRow(tr); if (!td) return;
      var rs = inp("text", "Why is this bill wrong? (kept on record)"); rs.maxLength = 300;
      var go = el("button", "btn", "Void bill"); go.type = "button";
      var row = el("div", "vb-grid"); row.appendChild(field("Reason", rs)); var g = el("div", "vb-fld"); g.appendChild(go); row.appendChild(g); td.appendChild(row);
      go.addEventListener("click", async function () {
        if (String(rs.value || "").trim().length < 3) { msg.textContent = "Give a reason (at least 3 characters)."; return; }
        go.disabled = true;
        try { await B.vendorBills.void(b.id, rs.value); msg.textContent = "Bill voided (kept on record)."; await reload(); }
        catch (e) { go.disabled = false; msg.textContent = errText(e); }
      });
    }
    var formDrawn = "";
    function renderForm() {
      // R190: a closed event takes a bill only as a "late adjustment" (with a reason, by the people the studio allows)
      var late = !!(ex && ex.closed);
      var want = !canEdit ? "none" : late ? (ex.can_late ? "late" : "closed") : "normal";
      if (want === formDrawn) return; formDrawn = want;
      clear(formBox); if (want === "none") return;
      if (want === "closed") {
        var cn = el("div", "vb-note"); cn.appendChild(el("b", null, "This event is closed. "));
        cn.appendChild(document.createTextNode(ex.late_who === "finance" ? "A bill that came late can be added by someone who can edit Finance." : "A bill that came late can be added by a studio admin, with the reason (a late adjustment)."));
        formBox.appendChild(cn); return;
      }
      var tabs = el("div", "vb-tabs"), full = el("button", "btn vb-on", late ? "Add a late bill" : "Add a bill"), quick = el("button", "btn", "📲 Quick add from WhatsApp");
      full.type = quick.type = "button"; tabs.appendChild(full); if (!late) tabs.appendChild(quick); formBox.appendChild(tabs);
      if (late) formBox.appendChild(el("p", "vb-muted", "This event is closed. A bill added now is a late adjustment: the event stays closed, the cost counts in its profit, and the reason is kept on record."));
      var g = el("div", "vb-grid");
      var bk = el("select"); var o0 = el("option", null, "Not linked to a booking"); o0.value = ""; bk.appendChild(o0);
      bookings.forEach(function (b) { var o = el("option", null, (b.label || "Vendor booking") + (b.cost != null ? " (booked " + fmt(b.cost) + ")" : "")); o.value = b.id; bk.appendChild(o); });
      var no = inp("text", "e.g. INV-204"); no.maxLength = 80;
      var bd = inp("date"); bd.value = today();
      var dd = inp("date");
      var amt = inp("number", "0"); amt.min = "0"; amt.step = "0.01";
      var ds = inp("text", "e.g. Flowers - stage + entrance"); ds.maxLength = 500;
      // r21 money (0246): optional GST inside the bill, and whether its input credit can be claimed
      // (claimable GST is not a cost; food / catering GST usually is). Empty = "GST unknown".
      var gst = inp("number", "optional"); gst.min = "0"; gst.step = "0.01"; gst.classList.add("hbp-mi");
      var claim = inp("checkbox"); claim.checked = true; var claimTouched = false;
      claim.addEventListener("change", function () { claimTouched = true; });
      function foodLike(b) { return /(cater|food|meal|buffet|menu|kitchen|beverage|\bbar\b)/i.test([b && b.kind, b && b.label].join(" ")); }
      var fl = inp("file"); fl.accept = "image/png,image/jpeg,image/webp,application/pdf";
      var why = inp("text", "e.g. Generator bill came a week after the event"); why.maxLength = 500;
      var add = el("button", "btn primary", late ? "Add late bill" : "Add bill"); add.type = "button";
      var fBk = field("Vendor booking", bk), fNo = field("Bill no.", no), fBd = field("Bill date", bd), fDd = field("Due date", dd),
          fAmt = field("Amount (incl. GST)", amt), fGst = field("of which GST", gst), fDs = field("What for", ds), fFl = field("Photo / PDF", fl), fGo = el("div", "vb-fld");
      var fWhy = field("Why is it late? (kept on record)", why); fWhy.classList.add("vb-wide"); fWhy.hidden = !late;
      var fCl = el("label", "vb-fld vb-chk"); fCl.appendChild(claim); fCl.appendChild(el("span", null, "We can claim this GST (input credit)"));
      fCl.title = "Claimable GST is not a cost of the event. GST on food / catering usually can't be claimed.";
      bk.addEventListener("change", function () { if (claimTouched) return; claim.checked = !foodLike(bookings.find(function (b) { return b.id === bk.value; })); });
      fGo.appendChild(add);
      [fBk, fNo, fBd, fDd, fAmt, fGst, fCl, fDs, fFl, fWhy, fGo].forEach(function (n) { g.appendChild(n); });
      formBox.appendChild(g);
      var quickMode = false;
      function mode(q) {
        quickMode = q; full.classList.toggle("vb-on", !q); quick.classList.toggle("vb-on", q);
        [fBk, fNo, fBd, fDd, fDs, fGst, fCl].forEach(function (n) { n.hidden = q; });
        fl.accept = q ? "image/png,image/jpeg,image/webp" : "image/png,image/jpeg,image/webp,application/pdf";
        fFl.firstChild.textContent = q ? "WhatsApp photo of the bill" : "Photo / PDF";
      }
      full.addEventListener("click", function () { mode(false); }); quick.addEventListener("click", function () { mode(true); });
      add.addEventListener("click", async function () {
        var a = Number(amt.value);
        if (!(a > 0)) { msg.textContent = "Enter the bill amount (above zero)."; amt.focus(); return; }
        var file = fl.files && fl.files[0] ? fl.files[0] : null;
        if (quickMode && !file) { msg.textContent = "Choose the photo of the bill."; return; }
        if (!quickMode && dd.value && bd.value && dd.value < bd.value) { msg.textContent = "The due date is before the bill date."; return; }
        if (late && String(why.value || "").trim().length < 10) { msg.textContent = "Say why this bill came after the event was closed (at least 10 characters)."; why.focus(); return; }
        var gp = quickMode ? { value: null } : B.vendorBills.gstPart(gst.value, a);
        if (gp.error) { msg.textContent = gp.error; gst.focus(); return; }
        add.disabled = true; msg.textContent = file ? "Uploading…" : "Saving…";
        var bill = quickMode
          ? { amount: a, description: "From WhatsApp", bill_date: today() }
          : { amount: a, bill_no: no.value, bill_date: bd.value, due_date: dd.value, description: ds.value, booking_id: bk.value || null,
              vendor_id: (bookings.find(function (b) { return b.id === bk.value; }) || {}).vendor_id || null,
              gst_amount: gp.value, gst_claimable: gp.value != null ? claim.checked : undefined };
        try {
          if (late) { await B.vendorBills.addLate(id, bill, file, why.value); msg.textContent = "Late bill added (the event stays closed; the reason is kept)."; }
          else {
            var added = await B.vendorBills.add(id, bill, file);
            msg.textContent = (added && added.gst_dropped) ? "Bill added (the GST split needs database update 0246 - it was not saved)." : "Bill added.";
          }
          amt.value = ""; no.value = ""; ds.value = ""; dd.value = ""; fl.value = ""; gst.value = ""; why.value = ""; await reload();
        } catch (e) { msg.textContent = (e && e.code === "vendor_bills_missing") ? e.message : errText(e); }
        add.disabled = false;
      });
    }
    await reload();
  }

  // ---------------- Closure / Budget: per-event P&L ----------------
  async function mountPnl(box) {
    var B = S(), id = qid(); if (!id) return;
    // QA1017: event_pnl needs finance view (42501 otherwise) - roles without it keep the page's older card
    var finOk = true; try { finOk = await B.auth.canView("finance"); } catch (e) { finOk = false; }
    if (!finOk) { box.hidden = true; return; }
    var fmt = await fmtFor(id);
    clear(box); box.classList.add("card", "vb-card");
    box.appendChild(el("h2", null, box.getAttribute("data-vb-title") || "📊 Net profit"));   // r24: Budget calls it the planned-profit breakdown
    box.appendChild(el("p", "sub", "Revenue (without tax) − vendors − logistics & other − staff expenses."));
    var body = el("div", "vb-pnl"); box.appendChild(body);
    var seq = 0, timer = null;
    var replaces = box.getAttribute("data-vb-replaces") ? document.getElementById(box.getAttribute("data-vb-replaces")) : null;
    async function draw() {
      var my = ++seq;
      if (!body.firstChild) body.appendChild(el("p", "vb-muted", "Loading…"));
      var p; try { p = await B.vendorBills.pnl(id); } catch (e) { if (my !== seq) return; clear(body); body.appendChild(el("p", "vb-err", "Couldn't work out the profit: " + errText(e))); return; }
      if (my !== seq) return;                                     // a newer refresh is on its way
      clear(body);
      [["Revenue", p.revenue, "", ""], ["Vendors", p.vendors, "− ", "neg"], ["Logistics & other", p.other, "− ", "neg"], [p.rules === "r21" ? "Staff wages & expenses" : "Staff expenses", p.staff, "− ", "neg"]].concat(Number(p.refunds || 0) > 0 ? [["Refunds to client", p.refunds, "− ", "neg"]] : []).forEach(function (r) {
        var row = el("div", "vb-pl-row"); row.appendChild(el("span", null, r[0])); row.appendChild(money(el("b", r[3], r[2] + fmt(r[1])))); body.appendChild(row);
      });
      var net = Number(p.net_profit || 0), tot = el("div", "vb-pl-row vb-pl-net");
      tot.appendChild(el("span", null, "Net profit" + (p.margin_pct != null ? " (" + p.margin_pct + "%)" : "")));
      tot.appendChild(money(el("b", net < 0 ? "neg" : "pos", fmt(net)))); body.appendChild(tot);
      if (Number(p.tax || 0) > 0) { var tx = el("p", "vb-muted"); tx.appendChild(document.createTextNode("Tax collected (payable, not profit): ")); tx.appendChild(money(el("span", null, fmt(p.tax)))); body.appendChild(tx); }
      if (p.source === "client" && p.missing0124) body.appendChild(el("p", "vb-muted", "Vendor bills aren't counted yet - they start counting after database update 0124."));
      // one profit number per page: once the full P&L (with vendor bills) is live, hide the older card it replaces
      if (replaces) replaces.hidden = p.source === "server";
    }
    function soon() { clearTimeout(timer); timer = setTimeout(draw, 150); }
    document.addEventListener("helm:vendor-bills-changed", soon);
    document.addEventListener("helm:pnl-refresh", soon);
    await draw();
  }

  // ---------------- Business: payables, net profit by month, top events ----------------
  /* r21 business ui: laid out like the rest of the Business page - a section header, a row of 4 tiles,
     then two cards with proper tables (header row, right-aligned money, hairlines). Same data, same masking. */
  var SVGNS = "http://www.w3.org/2000/svg";
  function bzIcon(d) { var s = document.createElementNS(SVGNS, "svg"); s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("class", "bz-ic"); s.setAttribute("aria-hidden", "true");
    d.split("|").forEach(function (x) { var p = document.createElementNS(SVGNS, "path"); p.setAttribute("d", x); s.appendChild(p); }); return s; }
  var BZ_IC = { month: "M4 6h16v14H4z|M4 10h16|M8 3v4|M16 3v4", top: "M4 20V10|M10 20V4|M16 20v-7|M22 20H2", check: "M5 12l5 5 9-10" };
  function bzCard(title, ic, id) {
    var c = el("section", "bz-card"); c.setAttribute("aria-label", title); if (id) c.id = id;
    var hd = el("div", "bz-head"); hd.appendChild(bzIcon(ic)); hd.appendChild(el("h3", null, title)); c.appendChild(hd); return c;
  }
  function bzEmpty(box, text) { var e = el("div", "bz-empty"); e.appendChild(bzIcon(BZ_IC.check)); e.appendChild(el("span", null, text)); box.appendChild(e); }
  async function mountBusiness(box) {
    var B = S(), fmt = function (n) { try { return B.studioMoney(n); } catch (e) { return String(Math.round(n)); } };
    clear(box); box.hidden = false; box.classList.add("vb-biz", "bz", "bz-profit");
    var h = el("section", "bz-sec"); h.setAttribute("aria-labelledby", "bzProfitT"); box.appendChild(h);
    var sh = el("div", "bz-sec-head"), st = el("h2", "bz-sec-t", "Vendor payables & net profit"); st.id = "bzProfitT"; sh.appendChild(st);
    sh.appendChild(el("p", "bz-sec-sub", "What you owe vendors, and profit after vendors, logistics and staff expenses (confirmed events: the last 12 months and the next 12)."));
    h.appendChild(sh);
    var pay, biz;
    try { pay = await B.vendorBills.payables(); } catch (e) { pay = null; }
    // upcoming confirmed events count too (most studios book months ahead); the server allows up to 3 years
    try { var d = new Date(), from = new Date(d.getFullYear(), d.getMonth() - 11, 1), to = new Date(d.getFullYear(), d.getMonth() + 13, 0);
      biz = await B.vendorBills.business(ymd(from), ymd(to)); } catch (e) { biz = null; }
    if (!pay && !biz) { missingNote(h, "Payables and net profit"); return; }
    if (pay) {
      var tiles = el("div", "bz-kpis bz-kpis-sm"); tiles.setAttribute("aria-label", "Vendor payables");
      [["Owed to vendors", pay.outstanding, pay.outstanding > 0 ? "wait" : "", "Bills not yet paid"], ["Overdue", pay.overdue, pay.overdue > 0 ? "bad" : "", "Past the bill due date"],
       ["Due in 7 days", pay.due_7d, "", "Bills due this week"], ["Paid to vendors", pay.paid, "ok", "Payouts recorded"]].forEach(function (x) {
        var c = el("div", "bz-kpi bz-kpi-sm"), tp = el("div", "bz-kpi-top"); tp.appendChild(el("span", "bz-kpi-l", x[0])); c.appendChild(tp);
        c.appendChild(money(el("b", "bz-kpi-v" + (x[2] ? " bz-t-" + x[2] : ""), fmt(Number(x[1] || 0))))); c.appendChild(el("span", "bz-kpi-sub", x[3])); tiles.appendChild(c);
      });
      h.appendChild(tiles);
      if (Array.isArray(pay.currencies) && pay.currencies.length > 1) h.appendChild(el("p", "vb-muted bz-caption", "Bills are in more than one currency (" + pay.currencies.join(", ") + "); these totals add them together."));
    }
    var evs = biz && Array.isArray(biz.events) ? biz.events : [];
    if (!evs.length) { var ec = el("div", "bz-card"); bzEmpty(ec, "No confirmed events in the last 12 months or the next 12 yet."); h.appendChild(ec); return; }
    // QA1017: never add amounts in different currencies - totals use the studio currency only, others are listed apart
    var sCur = "INR"; try { sCur = String(B.studioCurrency() || "INR").toUpperCase(); } catch (e) {}
    var other = evs.filter(function (e) { return e.currency && String(e.currency).toUpperCase() !== sCur; });
    evs = evs.filter(function (e) { return !e.currency || String(e.currency).toUpperCase() === sCur; });
    if (other.length) h.appendChild(el("p", "vb-muted bz-caption", other.length + " event" + (other.length > 1 ? "s" : "") + " priced in another currency (" + other.map(function (e) { return String(e.currency).toUpperCase(); }).filter(function (c, i, a) { return a.indexOf(c) === i; }).join(", ") + ") not included in the " + sCur + " totals below."));
    if (!evs.length) return;
    var byMonth = {};
    evs.forEach(function (e) { var m = String(e.date || "").slice(0, 7); if (!m) return; byMonth[m] = byMonth[m] || { rev: 0, net: 0, n: 0 }; byMonth[m].rev += Number(e.revenue || 0); byMonth[m].net += Number(e.net_profit || 0); byMonth[m].n++; });
    /* cols: [label, kind] - kind "txt" | "num" (plain number) | "money" (masked span). Cells: string or a node. */
    function table(cols, rows, caption) {
      var w = el("div", "bz-tbl-wrap"), t = el("table", "vb-table bz-tbl"), th = el("thead"), tr = el("tr");
      t.setAttribute("data-tm", "off");   // its own phone layout (cards) below, not tables-mobile.js
      if (caption) { var cp = el("caption", "bz-sr", caption); t.appendChild(cp); }
      cols.forEach(function (x) { var c = el("th", x[1] !== "txt" ? "num" : null, x[0]); c.scope = "col"; tr.appendChild(c); }); th.appendChild(tr); t.appendChild(th);
      var b = el("tbody"); rows.forEach(function (r) { var row = el("tr"); if (r.cls) row.className = r.cls;
        r.cells.forEach(function (v, i) { var k = cols[i][1], c = el("td", k !== "txt" ? "num" : "bz-tc-main"); c.setAttribute("data-label", cols[i][0]);
          if (v && v.nodeType) c.appendChild(v);
          else if (k === "money") { var sp = money(el("span", "bz-m", v)); if (r.neg && r.neg[i]) sp.classList.add("bz-t-bad"); c.appendChild(sp); }
          else c.textContent = v;
          row.appendChild(c); }); b.appendChild(row); });
      t.appendChild(b); w.appendChild(t); return w;
    }
    function pill(text, cls) { return el("span", "bz-pill " + cls, text); }
    var grid = el("div", "bz-grid bz-grid-even"); h.appendChild(grid);
    var cM = bzCard("Net profit by month", BZ_IC.month, "bz-profit-month"), cT = bzCard("Top events by profit", BZ_IC.top, "bz-profit-top");
    grid.appendChild(cM); grid.appendChild(cT);
    var months = Object.keys(byMonth).sort().reverse(), thisMonth = today().slice(0, 7);
    cM.appendChild(table([["Month", "txt"], ["Events", "num"], ["Revenue", "money"], ["Net profit", "money"]], months.map(function (m) {
      var x = byMonth[m], d = new Date(m + "-01T00:00:00"), lab = el("span", "bz-cell-row");
      lab.appendChild(el("span", null, d.toLocaleDateString(undefined, { month: "short", year: "numeric" })));
      if (m > thisMonth) lab.appendChild(pill("Upcoming", "bz-pill-up")); else if (m === thisMonth) lab.appendChild(pill("This month", "bz-pill-now"));
      return { cls: m > thisMonth ? "bz-tr-up" : "", neg: [0, 0, 0, x.net < 0], cells: [lab, String(x.n), fmt(x.rev), fmt(x.net)] };
    }), "Net profit by month"));
    var top = evs.slice().sort(function (a, b) { return Number(b.net_profit || 0) - Number(a.net_profit || 0); }).slice(0, 10);
    cT.appendChild(table([["Event", "txt"], ["Margin", "num"], ["Revenue", "money"], ["Net profit", "money"]], top.map(function (e) {
      var a = el("a", "bz-ev-link"); a.href = "closure.html?quote=" + encodeURIComponent(e.quote_id);
      if (e.code) a.appendChild(el("span", "bz-code", e.code));
      /* a free-trial sample title ("Demo · X") shows as "X" + a Sample pill, like the rest of the page (display only) */
      var tt = String(e.title || "Event"), smp = /^\s*(?:demo|sample)(?:\s*[\u00b7\u2022:]|\s+[\-\u2013\u2014])\s*/i, t2 = tt.replace(smp, "");
      a.appendChild(el("span", "bz-ev-t", t2 || tt)); if (t2 && t2 !== tt) a.appendChild(pill("Sample", "bz-pill-smp"));
      return { neg: [0, 0, 0, Number(e.net_profit || 0) < 0], cells: [a, e.margin_pct != null ? e.margin_pct + "%" : "—", fmt(e.revenue), fmt(e.net_profit)] };
    }), "Top events by profit"));
    /* r24: the per-event profit list already lives on Insights ("Profit per event") - when this role can open
       Insights, show it there only (one place) and leave a link here; otherwise keep the card. */
    try { var IA = B.auth; Promise.resolve(IA && IA.enabled && IA.enabled() ? IA.canView("insights") : true).then(function (v) {
      if (v !== true) return; cT.hidden = true; grid.classList.remove("bz-grid-even"); grid.classList.add("bz-grid-one");
      var ln = el("p", "vb-muted bz-caption"), a = el("a", null, "Profit for each event → Insights"); a.href = "insights.html"; ln.appendChild(a); cM.appendChild(ln);
    }, function () {}); } catch (e) {}
  }

  // ---------------- Business: vendor bills to pay, TDS report, reminder settings (R190, 0373) ----------------
  /* Three cards under the payables: "Bills to pay" (due in 14 days + overdue + GST 150-day warnings, a WhatsApp-ready
     summary to copy), "TDS deducted" (this financial year, CSV for the CA) and "Vendor bill reminders" (who pays vendors,
     when, vendor reminder off by default, cash limit, GST warning days, default TDS, who may add late bills; admins edit).
     Finance view only; a server without 0373 shows nothing here. */
  function csvCell(v) {
    var s = v == null ? "" : String(v);
    // spreadsheet formula injection guard (R32 / r139: leading spaces and full-width forms count; real numbers stay numbers)
    if (typeof v !== "number" && /^[\s 　]*[=+\-@\t\r＝＋－＠]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }
  function fyStart(t) { var y = Number(String(t).slice(0, 4)), m = Number(String(t).slice(5, 7)); return (m >= 4 ? y : y - 1) + "-04-01"; }
  // pure: the WhatsApp-ready text of the bills to pay (exported for tests)
  function dueSummary(rows, fmt, today0) {
    var list = (rows || []).filter(function (r) { return r && r.state !== "gst"; });
    if (!list.length) return "No vendor bills due in the next 2 weeks.";
    var over = list.filter(function (r) { return r.state === "overdue"; }), soon = list.filter(function (r) { return r.state !== "overdue"; });
    var line = function (r) { return "- " + (r.vendor || "Vendor") + ": " + fmt(r.open) + (r.bill_no ? " (#" + r.bill_no + ")" : "") + " - " + (r.event || "Event") +
      (r.state === "overdue" ? ", " + Math.abs(Number(r.days) || 0) + " days late" : r.state === "today" ? ", due today" : ", due " + r.due_date); };
    var out = ["Vendor bills to pay (" + today0 + ")"];
    if (over.length) { out.push("", "Overdue:"); over.forEach(function (r) { out.push(line(r)); }); }
    if (soon.length) { out.push("", "Coming up:"); soon.forEach(function (r) { out.push(line(r)); }); }
    var tot = list.reduce(function (a, r) { return a + Number(r.open || 0); }, 0);
    out.push("", "Total: " + fmt(tot));
    return out.join("\n");
  }
  async function mountDue(box) {
    var B = S(); if (!B.vendorBills || !B.vendorBills.due) { box.hidden = true; return; }
    var finOk = true; try { finOk = await B.auth.canView("finance"); } catch (e) { finOk = false; }
    if (!finOk) { box.hidden = true; return; }
    var fmt = function (n) { try { return B.studioMoney(n); } catch (e) { return String(Math.round(n)); } };
    var due = null; try { due = await B.vendorBills.due(14); } catch (e) { due = null; }
    if (!due) { box.hidden = true; return; }
    clear(box); box.hidden = false; box.classList.add("vb-biz", "bz", "bz-vbdue");
    var h = el("section", "bz-sec"); h.setAttribute("aria-labelledby", "bzVbDueT"); box.appendChild(h);
    var sh = el("div", "bz-sec-head"), st = el("h2", "bz-sec-t", "Vendor bills to pay"); st.id = "bzVbDueT"; sh.appendChild(st);
    sh.appendChild(el("p", "bz-sec-sub", "Bills due in the next 2 weeks or already late, the TDS you deducted, and who Helm reminds."));
    h.appendChild(sh);
    var t0 = today(), msg = el("div", "vb-msg"); msg.setAttribute("role", "status"); msg.setAttribute("aria-live", "polite");

    // 1) bills to pay
    var c1 = bzCard("Bills to pay", BZ_IC.month, "bz-vb-due"); h.appendChild(c1);
    var rows = Array.isArray(due.bills) ? due.bills : [];
    if (!rows.length) bzEmpty(c1, "No vendor bills due in the next 2 weeks.");
    else {
      var w = el("div", "bz-tbl-wrap"), tb = el("table", "vb-table bz-tbl vb-due-list"), th = el("thead"), hr = el("tr");
      tb.setAttribute("data-tm", "off");
      [["Vendor", 0], ["Event", 0], ["Due", 0], ["Left to pay", 1]].forEach(function (x) { var c = el("th", x[1] ? "num" : null, x[0]); c.scope = "col"; hr.appendChild(c); });
      th.appendChild(hr); tb.appendChild(th); var bd = el("tbody"); tb.appendChild(bd);
      rows.forEach(function (r) {
        var tr = el("tr", r.state === "overdue" ? "vb-over" : null);
        var cv = el("td", "bz-tc-main"); cv.setAttribute("data-label", "Vendor"); cv.appendChild(el("b", null, r.vendor || "Vendor"));
        if (r.bill_no) cv.appendChild(el("div", "vb-muted", "#" + r.bill_no));
        var ce = el("td"); ce.setAttribute("data-label", "Event"); var a = el("a", "bz-ev-link", r.event || "Event"); a.href = "settlement.html?quote=" + encodeURIComponent(r.quote_id) + "#vendorBills"; ce.appendChild(a);
        var cd = el("td"); cd.setAttribute("data-label", "Due");
        var pillT = r.state === "overdue" ? Math.abs(Number(r.days) || 0) + " days late" : r.state === "today" ? "Today" : r.state === "soon" ? "In " + r.days + (Number(r.days) === 1 ? " day" : " days") : "No due date";
        cd.appendChild(el("span", "bz-pill " + (r.state === "overdue" ? "bz-pill-bad" : r.state === "today" ? "bz-pill-now" : "bz-pill-up"), pillT));
        if (r.due_date) cd.appendChild(el("div", "vb-muted", r.due_date));
        if (r.gst_warn) cd.appendChild(el("div", "vb-warn", "GST credit: pay before " + (r.gst_deadline || "day 180")));
        var cm = el("td", "num"); cm.setAttribute("data-label", "Left to pay"); cm.appendChild(money(el("span", "bz-m", fmt(r.open))));
        [cv, ce, cd, cm].forEach(function (c) { tr.appendChild(c); }); bd.appendChild(tr);
      });
      w.appendChild(tb); c1.appendChild(w);
      var ra = el("div", "vb-row-act"), cp = el("button", "btn", "Copy for WhatsApp"); cp.type = "button";
      cp.addEventListener("click", async function () {
        var text = dueSummary(rows, fmt, t0);
        try { await navigator.clipboard.writeText(text); msg.textContent = "Copied - paste it into WhatsApp."; } catch (e) { msg.textContent = "Couldn't copy - your browser blocked it."; }
      });
      ra.appendChild(cp); c1.appendChild(ra);
    }

    // 2) TDS deducted this financial year
    var c2 = bzCard("TDS deducted (this financial year)", BZ_IC.top, "bz-vb-tds"); h.appendChild(c2);
    var rep = null; try { rep = await B.vendorBills.tdsReport(fyStart(t0), t0); } catch (e) { rep = null; }
    var tr2 = rep && Array.isArray(rep.rows) ? rep.rows : [];
    if (!tr2.length) bzEmpty(c2, "No TDS recorded on vendor payouts yet. Add it in the payout box on an event's Settlement page.");
    else {
      var byM = {}; tr2.forEach(function (r) { var k = r.month + " " + r.section; byM[k] = byM[k] || { m: r.month, s: r.section, n: 0, a: 0 }; byM[k].n++; byM[k].a += Number(r.amount || 0); });
      var w2 = el("div", "bz-tbl-wrap"), t2 = el("table", "vb-table bz-tbl"), h2 = el("thead"), r2 = el("tr"); t2.setAttribute("data-tm", "off");
      [["Month", 0], ["Section", 0], ["Payouts", 1], ["TDS", 1]].forEach(function (x) { var c = el("th", x[1] ? "num" : null, x[0]); c.scope = "col"; r2.appendChild(c); });
      h2.appendChild(r2); t2.appendChild(h2); var b2 = el("tbody"); t2.appendChild(b2);
      Object.keys(byM).sort().reverse().forEach(function (k) { var x = byM[k], tr = el("tr");
        var a1 = el("td", "bz-tc-main", x.m); a1.setAttribute("data-label", "Month"); var a2 = el("td", null, x.s); a2.setAttribute("data-label", "Section");
        var a3 = el("td", "num", String(x.n)); a3.setAttribute("data-label", "Payouts"); var a4 = el("td", "num"); a4.setAttribute("data-label", "TDS"); a4.appendChild(money(el("span", "bz-m", fmt(x.a))));
        [a1, a2, a3, a4].forEach(function (c) { tr.appendChild(c); }); b2.appendChild(tr); });
      w2.appendChild(t2); c2.appendChild(w2);
      var ra2 = el("div", "vb-row-act"), dl = el("button", "btn", "Download for your CA (CSV)"); dl.type = "button";
      dl.addEventListener("click", function () {
        var lines = [["paid_on", "section", "tds_amount", "vendor", "vendor_gstin", "bill_no", "bill_amount", "currency", "event_code", "event"]];
        tr2.forEach(function (r) { lines.push([r.paid_on, r.section, Number(r.amount), r.vendor, r.gstin, r.bill_no, Number(r.bill_amount), r.currency, r.code, r.event]); });
        var csv = lines.map(function (x) { return x.map(csvCell).join(","); }).join("\r\n");
        var url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
        var a = el("a"); a.href = url; a.download = "helm-vendor-tds-" + (rep.from || "") + "-to-" + (rep.to || "") + ".csv";
        document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
      });
      ra2.appendChild(dl); c2.appendChild(ra2);
    }

    // 3) reminder settings
    var c3 = bzCard("Vendor bill reminders", BZ_IC.check, "bz-vb-set"); h.appendChild(c3);
    var cfg = null; try { cfg = await B.vendorBills.settings(); } catch (e) { cfg = null; }
    if (cfg) drawSettings(c3, cfg);
    h.appendChild(msg);
    function drawSettings(card, c) {
      while (card.childNodes.length > 1) card.removeChild(card.lastChild);
      var ed = !!c.can_edit;
      card.appendChild(el("p", "vb-muted", "Helm reminds the person who pays vendors 3 days before a bill is due, on the day, and every few days while it is late (bell + e-mail; free trials get the bell only). Reminders go from 9:00 your studio time." +
        (ed ? "" : " Only a studio admin can change these.")));
      var payers = (c.payers || []).map(function (p) { return p.name; }).filter(Boolean);
      card.appendChild(el("p", "vb-muted", "Reminded now: " + (payers.length ? payers.join(", ") : "nobody yet (add an admin with an e-mail)")));
      var g = el("div", "vb-set");
      function sel(opts, v) { var s0 = el("select"); opts.forEach(function (o) { var x = el("option", null, o[1]); x.value = o[0]; if (String(o[0]) === String(v)) x.selected = true; s0.appendChild(x); }); s0.disabled = !ed; return s0; }
      function num(v, min, max) { var i = inp("number"); i.min = String(min); i.max = String(max); i.step = "1"; i.value = v == null ? "" : String(v); i.disabled = !ed; return i; }
      function chk(v, label) { var l = el("label", "vb-fld vb-chk"), i = inp("checkbox"); i.checked = !!v; i.disabled = !ed; l.appendChild(i); l.appendChild(el("span", null, label)); return [l, i]; }
      var on = chk(c.enabled !== false, "Send bill reminders");
      var roles = {}; (c.people || []).forEach(function (p) { roles[p.role] = 1; }); roles.admin = 1;
      var who = sel([["role", "Everyone with a role"], ["person", "One person"]], c.payer_kind || "role");
      var role = sel(Object.keys(roles).sort().map(function (r) { return [r, r.charAt(0).toUpperCase() + r.slice(1)]; }), c.payer_role || "admin");
      var person = sel([["", "Choose…"]].concat((c.people || []).map(function (p) { return [p.id, p.name + " (" + p.role + ")"]; })), c.payer_profile || "");
      var fRole = field("Role", role), fPerson = field("Person", person);
      function whoView() { fRole.hidden = who.value !== "role"; fPerson.hidden = who.value !== "person"; }
      who.addEventListener("change", whoView);
      var before = num(c.days_before, 0, 30), every = num(c.overdue_every, 1, 30);
      var onDay = chk(c.on_due_day !== false, "Also on the due day"), mail = chk(c.email_on !== false, "E-mail too (not only the bell)");
      var vend = chk(!!c.vendor_reminders, "Also remind the vendor (off by default)"), vdays = num(c.vendor_days_before, 1, 30);
      var cash = num(c.cash_limit, 0, 99999999), gstd = num(c.gst_warn_days, 30, 179);
      var sec = inp("text", "e.g. 194C"); sec.maxLength = 8; sec.value = c.tds_section || ""; sec.disabled = !ed;
      var pct = inp("number", "none"); pct.min = "0"; pct.max = "30"; pct.step = "0.01"; pct.value = c.tds_pct == null ? "" : String(c.tds_pct); pct.disabled = !ed;
      var late = sel([["admin", "Admins only"], ["finance", "Anyone who can edit Finance"]], c.late_who || "admin");
      [on[0], field("Who pays vendors", who), fRole, fPerson, field("Days before the due date", before), onDay[0], field("While late, every N days", every), mail[0],
       vend[0], field("Vendor reminder: days before", vdays), field("Cash warning above (per vendor per day)", cash), field("GST credit warning at (days)", gstd),
       field("Default TDS section", sec), field("Default TDS %", pct), field("Bills after an event is closed", late)].forEach(function (n) { g.appendChild(n); });
      card.appendChild(g); whoView();
      if (!ed) return;
      var ra = el("div", "vb-row-act"), save = el("button", "btn primary", "Save reminders"); save.type = "button"; ra.appendChild(save); card.appendChild(ra);
      save.addEventListener("click", async function () {
        if (who.value === "person" && !person.value) { msg.textContent = "Choose the person who pays vendors."; person.focus(); return; }
        var p = { enabled: on[1].checked, payer_kind: who.value, payer_role: role.value, payer_profile: who.value === "person" ? person.value : null,
          days_before: Math.round(Number(before.value)), on_due_day: onDay[1].checked, overdue_every: Math.round(Number(every.value)), email_on: mail[1].checked,
          vendor_reminders: vend[1].checked, vendor_days_before: Math.round(Number(vdays.value)), cash_limit: Number(cash.value), gst_warn_days: Math.round(Number(gstd.value)),
          tds_section: String(sec.value || "").trim().toUpperCase() || null, tds_pct: pct.value === "" ? null : Number(pct.value), late_who: late.value };
        if (p.tds_section && !/^19[0-9][A-Z]{0,3}$/.test(p.tds_section)) { msg.textContent = "A TDS section looks like 194C or 194J."; sec.focus(); return; }
        save.disabled = true; msg.textContent = "Saving…";
        try { var r = await B.vendorBills.saveSettings(p); msg.textContent = "Saved."; drawSettings(card, r || p); }
        catch (e) { save.disabled = false; msg.textContent = errText(e); }
      });
    }
  }

  // ---------------- self-mount once the page shows its app ----------------
  var MOUNTS = { bills: mountBills, pnl: mountPnl, business: mountBusiness, due: mountDue };
  function whenShown(gate, fn) {
    if (!gate) return;
    var done = false, run = function () { if (done || gate.hidden) return; done = true; obs.disconnect(); fn(); };
    var obs = new MutationObserver(run); obs.observe(gate, { attributes: true, attributeFilter: ["hidden"] }); run();
  }
  function start() {
    var nodes = document.querySelectorAll("[data-vb-mount]");
    Array.prototype.forEach.call(nodes, function (n) {
      var fn = MOUNTS[n.getAttribute("data-vb-mount")]; if (!fn) return;
      var gate = document.getElementById(n.getAttribute("data-vb-gate") || "app");
      whenShown(gate, function () { Promise.resolve().then(function () { return fn(n); }).catch(function (e) { try { console.warn("vendor bills:", e && e.message); } catch (_) {} }); });
    });
  }
  window.HelmVendorBills = { mountBills: mountBills, mountPnl: mountPnl, mountBusiness: mountBusiness, mountDue: mountDue, dueSummary: dueSummary, csvCell: csvCell };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
