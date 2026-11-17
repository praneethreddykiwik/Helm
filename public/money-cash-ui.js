/* money-cash-ui.js - R198 P&L clarity phase 2 (0377). Two tabs next to the R197 money header (money-header-ui.js):
     cash   "Cash in & out": came in / went out / still to come in / still to pay out, a bar + line chart by date with a
            "Today" line and the running "cash left", the plain "cash left is not profit" box with the exact parts (GST owed,
            GST you can claim back, client TDS, stock lost, costs with no money record yet), "Coming up" and "Already happened".
     owes   "Who owes what": the client (balance, next instalment, overdue, "Copy reminder for WhatsApp", Record payment), vendor
            bills unpaid / part paid by due date (Pay), crew wages (one total; per person for the studio admin only), staff
            pay-backs, refunds owed, GST to pay for this event and TDS deducted from vendors. Each row links to where you act.
   money-header-ui.js decides when to show them (Finance view only; hidden on a database without 0377) and draws the tab bar;
   this file only formats what event_money_cash returns - the server does every sum. DOM via createElement / textContent only.
   Every amount carries data-money so privacy mode masks it. */
(function (global) {
  "use strict";
  var SVGNS = "http://www.w3.org/2000/svg";
  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; }
  function sv(tag, attrs) { var e = document.createElementNS(SVGNS, tag); Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, String(attrs[k])); }); return e; }
  function money(node) { node.setAttribute("data-money", ""); return node; }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function has(v) { return v !== null && v !== undefined && v !== ""; }
  function plural(n, one, many) { return num(n) === 1 ? one : many; }

  // ---------------- pure helpers (unit-tested in test/r198-money-cash.test.mjs) ----------------
  // "2026-11-18" -> { day: "18", mon: "Nov", full: "18 Nov 2026", short: "18 Nov" }; anything else -> null
  function dparts(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
    if (!m) return null;
    var mi = Number(m[2]) - 1; if (mi < 0 || mi > 11) return null;
    var d = String(Number(m[3]));
    return { day: d, mon: MON[mi], short: d + " " + MON[mi], full: d + " " + MON[mi] + " " + m[1], y: Number(m[1]), m: mi + 1 };
  }
  // whole days from today (both "YYYY-MM-DD") - the server's today, never the browser clock
  function daysBetween(today, iso) {
    var a = dparts(today), b = dparts(iso); if (!a || !b) return null;
    return Math.round((Date.UTC(b.y, b.m - 1, Number(b.day)) - Date.UTC(a.y, a.m - 1, Number(a.day))) / 86400000);
  }
  function whenWords(days) {
    if (!has(days)) return "";
    var d = Math.round(num(days));
    if (d === 0) return "today"; if (d === 1) return "tomorrow"; if (d === -1) return "yesterday";
    return d > 0 ? "in " + d + " days" : Math.abs(d) + " days ago";
  }
  var HOW = { upi: "UPI", bank: "Bank transfer", neft: "Bank transfer", imps: "Bank transfer", rtgs: "Bank transfer", cash: "Cash", card: "Card",
    cheque: "Cheque", manual: "Recorded by hand", razorpay: "Online (Razorpay)", online: "Online" };
  function how(s) { var k = String(s || "").trim(); if (!k) return ""; var v = HOW[k.toLowerCase()]; return v || k; }
  // the entries split for the two lists: coming up (soonest first), already happened (newest first)
  function split(entries) {
    var up = [], done = [];
    (entries || []).forEach(function (e) { if (e && e.done) done.push(e); else if (e) up.push(e); });
    var by = function (a, b) { return String(a.date || "") < String(b.date || "") ? -1 : String(a.date || "") > String(b.date || "") ? 1 : 0; };
    up.sort(by); done.sort(function (a, b) { return -by(a, b); });
    return { up: up, done: done };
  }
  // the chip on a list row: { kind, text } or null
  function rowChip(e, today) {
    if (!e) return null;
    if (e.cash === false) return { kind: "", text: "Not cash" };
    if (e.done) return null;
    if (e.late) return { kind: "bad", text: e.dir === "in" ? "Overdue" : "Late" };
    var d = daysBetween(today, e.date);
    if (d !== null && d <= 1 && e.kind !== "wages") return { kind: "bad", text: "Soon" };
    if (d !== null && d <= 3 && e.kind !== "wages") return { kind: "warn", text: "This week" };
    if (e.no_date) return { kind: "", text: "No date" };
    return null;
  }
  // the "cash left is not profit" lines, each { label, amount, sign: "+"|"-"|"=", sub, kind } - only the parts that are not 0
  function explainRows(x, fmt) {
    x = x || {}; fmt = fmt || function (n) { return String(Math.round(num(n))); };
    var rows = [];
    rows.push({ label: "Profit of this event", amount: num(x.profit), sign: "", sub: "Revenue without GST minus every cost", kind: "profit" });
    var g = num(x.gst_to_pay);
    if (Math.abs(g) > 0.5 || num(x.gst_collected) > 0.5) {
      var sub = "GST collected " + fmt(x.gst_collected) + (num(x.gst_claimable) > 0.5 ? " − GST on vendor bills you can claim back " + fmt(x.gst_claimable) : "") + ". You pay it with your GST return.";
      rows.push({ label: g >= 0 ? "GST you owe the government" : "GST credit from vendor bills", amount: Math.abs(g), sign: g >= 0 ? "+" : "-", sub: sub, kind: "gst" });
    }
    if (Math.abs(num(x.stock_lost)) > 0.5) rows.push({ label: "Stock lost or damaged", amount: Math.abs(num(x.stock_lost)), sign: num(x.stock_lost) >= 0 ? "+" : "-", sub: "A cost in the profit, but no cash moved.", kind: "stock" });
    if (Math.abs(num(x.client_tds)) > 0.5) rows.push({ label: "TDS kept by the client", amount: Math.abs(num(x.client_tds)), sign: num(x.client_tds) >= 0 ? "-" : "+", sub: "Counted as paid, but it never reached your bank. Claim it back in your tax return.", kind: "tds" });
    if (Math.abs(num(x.vendor_tds)) > 0.5) rows.push({ label: "TDS you deducted from vendors", amount: Math.abs(num(x.vendor_tds)), sign: num(x.vendor_tds) >= 0 ? "+" : "-", sub: "Still in your account: you pay it to the tax office, not the vendor.", kind: "vtds" });
    var o = num(x.other);
    if (Math.abs(o) > 0.5) rows.push(o > 0
      ? { label: "Costs with no bill or payment in Helm yet", amount: o, sign: "+", sub: "Booked vendors without a bill, studio costs or corrections. When they are paid, cash left goes down by this much.", kind: "other" }
      : { label: "Money out that is not a cost (yet)", amount: -o, sign: "-", sub: "For example a refund waiting for approval, or a vendor paid more than the cost on the event.", kind: "other" });
    rows.push({ label: "Cash left after everyone is paid", amount: num(x.cash_left), sign: "=", sub: "", kind: "total" });
    return rows;
  }
  // the WhatsApp reminder to the client (plain text; copied, never sent by Helm)
  function waText(o, fmt) {
    o = o || {}; fmt = fmt || function (n) { return String(Math.round(num(n))); };
    var c = o.client || o, nx = c.next || null, ev = c.event_title ? c.event_title : "your event", d = dparts(c.event_date);
    var lines = [];
    lines.push("Hello" + (c.name ? " " + c.name : "") + ",");
    var t = "A friendly reminder about " + ev + (d ? " on " + d.full : "") + ". ";
    if (nx && num(nx.amount) > 0) {
      var nd = dparts(nx.date);
      t += (nx.label || "The next payment") + " of " + fmt(nx.amount) + (nd ? (nx.late ? " was due on " + nd.full : " is due on " + nd.full) : " is due") + ".";
    } else t += "The balance of " + fmt(c.balance) + " is due.";
    lines.push(t);
    if (nx && Math.abs(num(c.balance) - num(nx.amount)) > 0.5) lines.push("Total balance: " + fmt(c.balance) + ".");
    lines.push("Thank you!" + (c.studio ? " - " + c.studio : ""));
    return lines.join("\n");
  }
  // where a row's action lives: same page when it has the place, else Settlement / Closure of this event
  var ACT = { payments: ["settlement", "payments"], tds: ["settlement", "clientTds"], bills: ["settlement", "vendorBills"], claims: ["settlement", "claims"],
    refunds: ["settlement", "refunds"], crew: ["closure", "crewAttendance"], gst: ["business", ""] };
  function actHref(act, quoteId, here) {
    var a = ACT[act]; if (!a) return "";
    if (a[0] === "business") return "business.html";
    if (here && a[1] && here(a[1])) return "#" + a[1];
    return a[0] + ".html?quote=" + encodeURIComponent(String(quoteId || "")) + (a[1] ? "#" + a[1] : "");
  }
  // the chart: bars per date (in left, out right; due = faded), a running line, the Today line; numbers only, no DOM
  function chartModel(points, today, W) {
    var P = (points || []).filter(function (p) { return p && dparts(p.date); });
    W = Math.max(280, Math.min(760, num(W) || 600));
    var H = 196, pl = 8, pr = 8, top = 24, base = 168, n = P.length;
    if (!n) return { W: W, H: H, bars: [], line: [], labels: [], today: null, zero: base };
    var max = 0, rmax = 0, rmin = 0;
    P.forEach(function (p) { max = Math.max(max, num(p.in), num(p.out)); rmax = Math.max(rmax, num(p.run)); rmin = Math.min(rmin, num(p.run)); });
    var hi = Math.max(max, rmax, 1), lo = Math.min(0, rmin), span = hi - lo || 1;
    var y = function (v) { return base - (num(v) - lo) / span * (base - top); };
    var sx = (W - pl - pr) / n, bw = Math.max(3, Math.min(24, sx * 0.32)), zero = y(0), bars = [], line = [], labels = [], todayX = null, narrow = W < 520;
    var step = Math.max(1, Math.ceil(n / (narrow ? 5 : 10)));
    P.forEach(function (p, i) {
      var cx = pl + sx * i + sx / 2, d = dparts(p.date);
      if (todayX === null && String(p.date) >= String(today || "")) todayX = cx - sx / 2;
      var ind = num(p.in) - num(p.in_due), indue = num(p.in_due), outd = num(p.out) - num(p.out_due), outdue = num(p.out_due);
      if (ind > 0.5) bars.push({ x: cx - bw - 1, y: y(ind), w: bw, h: zero - y(ind), cls: "in" });
      if (indue > 0.5) bars.push({ x: cx - bw - 1, y: y(ind + indue), w: bw, h: y(ind) - y(ind + indue), cls: "in due" });
      if (outd > 0.5) bars.push({ x: cx + 1, y: y(outd), w: bw, h: zero - y(outd), cls: "out" });
      if (outdue > 0.5) bars.push({ x: cx + 1, y: y(outd + outdue), w: bw, h: y(outd) - y(outd + outdue), cls: "out due" });
      line.push({ x: cx, y: y(p.run) });
      if (i % step === 0 || i === n - 1) labels.push({ x: cx, text: narrow ? d.day + "/" + d.m : d.short });
    });
    if (todayX === null) todayX = W - pr - 2;
    return { W: W, H: H, bars: bars, line: line, labels: labels, today: todayX, zero: zero, base: base, top: top, end: num(P[n - 1].run) };
  }

  // ---------------- DOM pieces ----------------
  function mini(label, value, cls) {
    var d = el("div", "mc-mini"); d.appendChild(el("div", "mc-l", label));
    d.appendChild(money(el("div", "mc-n" + (cls ? " " + cls : ""), value))); return d;
  }
  function signed(fmt, n, dir) { return (dir === "out" ? "−" : "+") + fmt(Math.abs(num(n))); }
  function chip(c) { var s = el("span", "mh-chip" + (c.kind ? " " + c.kind : ""), c.text); return s; }
  function link(text, href, cls) { var a = el("a", "btn sm" + (cls ? " " + cls : ""), text); a.href = href; return a; }

  function drawChart(box, points, today, fmt, width) {
    var w = num(width); if (!w) { try { w = box.clientWidth || 0; } catch (e) { w = 0; } }
    var m = chartModel(points, today, w ? w - 4 : 600);
    if (!m.line.length) return;
    var s = sv("svg", { viewBox: "0 0 " + m.W + " " + m.H, role: "img", "class": "mc-chart", "aria-label": "Money in and out by date, with the cash left line" });
    s.appendChild(sv("line", { x1: 8, x2: m.W - 8, y1: m.zero, y2: m.zero, "class": "mc-axis" }));
    m.bars.forEach(function (b) { if (b.h > 0.2) s.appendChild(sv("rect", { x: b.x.toFixed(1), y: b.y.toFixed(1), width: b.w.toFixed(1), height: b.h.toFixed(1), rx: 3, "class": "mc-bar " + b.cls })); });
    if (m.today !== null) {
      s.appendChild(sv("line", { x1: m.today.toFixed(1), x2: m.today.toFixed(1), y1: m.top - 12, y2: m.base, "class": "mc-today" }));
      var tt = sv("text", { x: (m.today + 4).toFixed(1), y: m.top - 4, "class": "mc-today-t" }); tt.textContent = "Today"; s.appendChild(tt);
    }
    s.appendChild(sv("path", { d: m.line.map(function (p, i) { return (i ? "L" : "M") + p.x.toFixed(1) + " " + p.y.toFixed(1); }).join(" "), "class": "mc-run" }));
    m.line.forEach(function (p) { s.appendChild(sv("circle", { cx: p.x.toFixed(1), cy: p.y.toFixed(1), r: 3.5, "class": "mc-dot" })); });
    m.labels.forEach(function (l) { var t = sv("text", { x: l.x.toFixed(1), y: m.H - 6, "text-anchor": "middle", "class": "mc-x" }); t.textContent = l.text; s.appendChild(t); });
    var wrap = el("div", "mc-chart-wrap"); wrap.appendChild(s); box.appendChild(wrap);
    var lg = el("div", "mh-legend");
    [["in", "In"], ["out", "Out"], ["due", "Not yet (due)"]].forEach(function (x) { var sp = el("span"); sp.appendChild(el("i", "mc-k " + x[0])); sp.appendChild(document.createTextNode(x[1])); lg.appendChild(sp); });
    var ls = el("span"); ls.appendChild(el("i", "mc-k run")); ls.appendChild(document.createTextNode("Cash left from this event (")); ls.appendChild(money(el("span", null, fmt(m.end)))); ls.appendChild(document.createTextNode(" at the end)"));
    lg.appendChild(ls); box.appendChild(lg);
  }

  function tlRow(e, today, fmt) {
    var li = el("li", e.done ? "done" : null), d = dparts(e.date);
    var dd = el("div", "mc-d"); dd.appendChild(el("b", null, d ? d.day : "-")); dd.appendChild(document.createTextNode(d ? d.mon : "")); li.appendChild(dd);
    var w = el("div", "mc-w"); w.appendChild(el("b", null, e.who || ""));
    var sub = [how(e.how)]; if (e.ref) sub.push(e.ref);
    if (!e.done && d) { var dw = whenWords(daysBetween(today, e.date)); if (dw) sub.push(dw); }
    w.appendChild(el("span", null, sub.filter(Boolean).join(" · "))); li.appendChild(w);
    var a = el("div", "mc-amt"); a.appendChild(money(el("span", "num " + (e.cash === false ? "none" : e.dir), e.cash === false ? fmt(e.amount) : signed(fmt, e.amount, e.dir))));
    var c = rowChip(e, today); if (c) { a.appendChild(document.createTextNode(" ")); a.appendChild(chip(c)); }
    li.appendChild(a);
    return li;
  }

  function renderCash(box, c, fmt) {
    var t = c.totals || {}, x = c.explain || {};
    var sec = el("section", "mc-cash card"); sec.setAttribute("aria-label", "Cash in and out");
    sec.appendChild(el("h2", null, "Cash in & out"));
    sec.appendChild(el("p", "sub", "Real money that moves in your bank or cash box, by date. GST is included here because it really moves."));
    var g = el("div", "mc-sum");
    g.appendChild(mini("Came in", fmt(t.came_in), "in")); g.appendChild(mini("Went out", fmt(t.went_out), "out"));
    g.appendChild(mini("Still to come in", fmt(t.to_come), "in")); g.appendChild(mini("Still to pay out", fmt(t.to_pay), "out"));
    sec.appendChild(g);
    var bw = 0; try { bw = box.clientWidth || 0; } catch (e) { bw = 0; }   // the panel is on the page; the new card is not yet
    drawChart(sec, c.points, c.today, fmt, bw ? bw - 36 : 0);
    // the sentence + the exact parts
    var p = el("p", "mh-sentence");
    var left = num(t.cash_left);
    p.appendChild(document.createTextNode(left >= 0 ? "After everyone is paid, this event leaves " : "After everyone is paid, this event takes "));
    p.appendChild(money(el("b", null, fmt(Math.abs(left)))));
    p.appendChild(document.createTextNode(left >= 0 ? " in your account. " : " more out than came in. "));
    if (num(x.gst_to_pay) > 0.5) { p.appendChild(document.createTextNode("About ")); p.appendChild(money(el("b", null, fmt(x.gst_to_pay)))); p.appendChild(document.createTextNode(" of it is GST you owe the government. ")); }
    p.appendChild(document.createTextNode("That is why cash left is not the same as profit ("));
    p.appendChild(money(el("b", null, (num(x.profit) < 0 ? "−" : "") + fmt(Math.abs(num(x.profit))))));
    p.appendChild(document.createTextNode(")."));
    sec.appendChild(p);
    var ex = el("div", "mc-why"); ex.setAttribute("role", "group"); ex.setAttribute("aria-label", "Why cash left is not profit");
    ex.appendChild(el("h3", null, "Cash left ≠ profit"));
    var ul = el("ul", "mc-why-l");
    explainRows(x, fmt).forEach(function (r) {
      var li = el("li", "k-" + r.kind), l = el("span", "mc-wl");
      l.appendChild(el("b", null, r.label)); if (r.sub) l.appendChild(el("span", null, r.sub));
      li.appendChild(l);
      li.appendChild(money(el("span", "num", (r.sign === "=" ? "= " : r.sign === "+" ? "+ " : r.sign === "-" ? "− " : "") + (r.amount < 0 ? "−" : "") + fmt(Math.abs(r.amount)))));
      ul.appendChild(li);
    });
    ex.appendChild(ul);
    if (num(x.gst_blocked) > 0.5) {
      var nb = el("p", "mh-muted"); nb.appendChild(document.createTextNode("GST on vendor bills you cannot claim back ("));
      nb.appendChild(money(el("span", null, fmt(x.gst_blocked)))); nb.appendChild(document.createTextNode(") is a real cost: it is already inside the costs and the cash out."));
      ex.appendChild(nb);
    }
    if (num(x.advance) > 0.5) {
      var na = el("p", "mh-muted"); na.appendChild(document.createTextNode("The event has not happened yet: the "));
      na.appendChild(money(el("span", null, fmt(x.advance)))); na.appendChild(document.createTextNode(" that came in is an advance, not profit yet. Vendor and crew payments are still to come."));
      ex.appendChild(na);
    }
    sec.appendChild(ex);
    box.appendChild(sec);
    var sp = split(c.entries);
    var cols = el("div", "mc-cols");
    var up = el("section", "card"); up.appendChild(el("h2", null, "Coming up")); up.appendChild(el("p", "sub", "Next payments in and out, soonest first."));
    var ul1 = el("ul", "mc-tl"); sp.up.forEach(function (e) { ul1.appendChild(tlRow(e, c.today, fmt)); });
    if (!sp.up.length) up.appendChild(el("p", "mh-empty", "Nothing still to come in or to pay out.")); else up.appendChild(ul1);
    var dn = el("section", "card"); dn.appendChild(el("h2", null, "Already happened")); dn.appendChild(el("p", "sub", "Newest first."));
    var ul2 = el("ul", "mc-tl"); sp.done.forEach(function (e) { ul2.appendChild(tlRow(e, c.today, fmt)); });
    if (!sp.done.length) dn.appendChild(el("p", "mh-empty", "No money has moved yet.")); else dn.appendChild(ul2);
    cols.appendChild(up); cols.appendChild(dn); box.appendChild(cols);
  }

  function copyText(txt) {
    var done = function () { try { if (global.BPUI && global.BPUI.toast) global.BPUI.toast("Reminder copied - paste it in WhatsApp", { type: "ok" }); } catch (e) {} };
    try { if (global.navigator && global.navigator.clipboard && global.navigator.clipboard.writeText) { return global.navigator.clipboard.writeText(txt).then(done, function () { fallback(txt); }); } } catch (e) {}
    fallback(txt);
    function fallback(s) {
      var ta = el("textarea", "mc-copy"); ta.value = s; ta.setAttribute("readonly", ""); ta.setAttribute("aria-label", "Reminder text");
      document.body.appendChild(ta); ta.select(); var ok = false; try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      document.body.removeChild(ta); if (ok) done(); else try { if (global.BPUI && global.BPUI.toast) global.BPUI.toast("Could not copy. Select the text and copy it.", { type: "err" }); } catch (e) {}
    }
  }

  function oweRow(list, who, sub, amount, fmt, extra) {
    var li = el("li"), w = el("div", "mc-who"); w.appendChild(el("b", null, who)); if (sub) w.appendChild(el("span", null, sub)); li.appendChild(w);
    (extra && extra.chips || []).forEach(function (c) { li.appendChild(chip(c)); });
    li.appendChild(money(el("span", "num", fmt(amount))));
    if (extra && extra.href) li.appendChild(link(extra.label || "Open", extra.href));
    list.appendChild(li); return li;
  }

  function renderOwes(box, c, fmt, ctx) {
    ctx = ctx || {}; var o = c.owes || {}, cl = o.client || {}, vb = o.vendors || {}, cr = o.crew || {}, cm = o.claims || {}, rf = o.refunds || {}, g = o.gst || {};
    var href = function (act) { return actHref(act, c.quote_id, ctx.here); };
    var top = el("div", "mc-cols3");
    // client
    var s1 = el("section", "card mc-owe"); s1.appendChild(el("div", "mh-muted", "Client owes you"));
    s1.appendChild(money(el("div", "mc-big" + (num(cl.balance) > 0 ? " in" : ""), fmt(cl.balance))));
    var nx = cl.next, sub1 = "";
    if (num(cl.balance) <= 0.5) sub1 = num(cl.quoted) > 0 ? "Fully paid." : "Nothing to collect yet (no price).";
    else if (nx) { var nd = dparts(nx.date); sub1 = "Next: " + (nx.label || "payment") + " " + (nd ? (nx.late ? "was due " + nd.full : "due " + nd.full + " (" + whenWords(nx.days) + ")") : "(no date)"); }
    var sp1 = el("div", "mh-muted"); sp1.appendChild(document.createTextNode(sub1));
    if (nx && num(nx.amount) > 0.5 && Math.abs(num(nx.amount) - num(cl.balance)) > 0.5) { sp1.appendChild(document.createTextNode(" · ")); sp1.appendChild(money(el("span", null, fmt(nx.amount)))); }
    s1.appendChild(sp1);
    if (num(cl.tds) > 0.5) { var td = el("div", "mh-muted"); td.appendChild(document.createTextNode("TDS kept by the client: ")); td.appendChild(money(el("span", null, fmt(cl.tds)))); s1.appendChild(td); }
    var b1 = el("div", "mc-acts");
    if (num(cl.balance) > 0.5) {
      if (cl.overdue) { var oc = chip({ kind: "bad", text: "Overdue" }); b1.appendChild(oc); }
      var wa = el("button", "btn sm primary", "Copy reminder for WhatsApp"); wa.type = "button";
      wa.addEventListener("click", function () { copyText(waText(o, fmt)); }); b1.appendChild(wa);
      b1.appendChild(link("Record payment", href("payments")));
    } else b1.appendChild(chip({ kind: "good", text: "Settled" }));
    s1.appendChild(b1); top.appendChild(s1);
    // vendors
    var s2 = el("section", "card mc-owe"); s2.appendChild(el("div", "mh-muted", "You owe vendors"));
    s2.appendChild(money(el("div", "mc-big", fmt(vb.total))));
    var first = (vb.bills || [])[0], f2 = "";
    if (!num(vb.count)) f2 = "No open vendor bills.";
    else { var fd = first && dparts(first.due_date); f2 = num(vb.count) + " " + plural(vb.count, "bill", "bills") + (fd ? " · next due " + fd.short + " (" + whenWords(first.days) + ")" : " · no due date"); }
    s2.appendChild(el("div", "mh-muted", f2)); top.appendChild(s2);
    // crew + staff
    var s3 = el("section", "card mc-owe"); s3.appendChild(el("div", "mh-muted", "You owe crew & staff"));
    var staff = num(cm.approved) + num(cm.waiting);
    s3.appendChild(money(el("div", "mc-big", fmt(num(cr.total) + staff))));
    var sb3 = el("div", "mh-muted"); sb3.appendChild(document.createTextNode("Wages ")); sb3.appendChild(money(el("span", null, fmt(cr.total))));
    sb3.appendChild(document.createTextNode(" (" + num(cr.people) + " " + plural(cr.people, "person", "people") + ") + pay-backs ")); sb3.appendChild(money(el("span", null, fmt(staff))));
    s3.appendChild(sb3); top.appendChild(s3);
    box.appendChild(top);

    var cols = el("div", "mc-cols");
    var v = el("section", "card"); v.appendChild(el("h2", null, "Vendor bills to pay"));
    v.appendChild(el("p", "sub", "Due date first. A bill can be paid after closing without re-opening the event."));
    var ul = el("ul", "mc-owes");
    (vb.bills || []).forEach(function (b) {
      var chips = [], d = dparts(b.due_date), n = has(b.days) ? num(b.days) : null;
      chips.push({ kind: b.late ? "bad" : n !== null && n <= 1 ? "bad" : n !== null && n <= 3 ? "warn" : "", text: d ? (b.late ? "Overdue · due " + d.short : "Due " + d.short + " · " + whenWords(n)) : "No due date" });
      if (b.part) chips.push({ kind: "info", text: "Part paid" });
      var sub = [b.bill_no ? "Bill " + b.bill_no : "", b.what || "", b.gst === "claimable" ? "GST can be claimed" : b.gst === "not_claimable" ? "GST cannot be claimed" : ""].filter(Boolean).join(" · ");
      oweRow(ul, b.who || "Vendor", sub, b.open, fmt, { chips: chips, href: href("bills"), label: "Pay" });
    });
    if (!(vb.bills || []).length) v.appendChild(el("p", "mh-empty", "Nothing to pay vendors on this event.")); else v.appendChild(ul);
    cols.appendChild(v);

    var s = el("section", "card"); s.appendChild(el("h2", null, "Crew, staff & tax"));
    s.appendChild(el("p", "sub", cr.private ? "Per-person wages are shown to the studio admin only." : "Per-person wages (you see them as the studio admin)."));
    var ul2 = el("ul", "mc-owes");
    if (num(cr.total) > 0.5) {
      var cd = dparts(cr.date);
      oweRow(ul2, "Crew wages", num(cr.people) + " " + plural(cr.people, "person", "people") + (cd ? " · event day " + cd.short : "") + " · Helm does not record wage payments, so this is the full wage bill", cr.total, fmt, { href: href("crew"), label: "Attendance" });
      if (!cr.private) (cr.per_person || []).forEach(function (p) {
        var li = oweRow(ul2, p.name || "Crew", (p.stage === "actual" ? "Actual" : "Expected") + (p.note ? " · " + p.note : ""), p.amount, fmt);
        li.classList.add("mc-sub");
      });
    }
    (cm.items || []).forEach(function (x) {
      oweRow(ul2, "Pay back " + (x.who || "staff"), (x.what || "Expense claim") + (x.status === "approved" ? " · approved" : " · waiting approval"), x.amount, fmt,
        { chips: x.status === "approved" ? [] : [{ kind: "warn", text: "Approve first" }], href: href("claims"), label: x.status === "approved" ? "Pay back" : "Review" });
    });
    (rf.items || []).forEach(function (x) {
      oweRow(ul2, "Refund to the client", (x.reason || "Refund") + (x.status === "approved" ? " · approved" : " · waiting approval"), x.amount, fmt, { href: href("refunds"), label: "Open" });
    });
    var gsub = "Collected " + fmt(g.collected) + (num(g.claimable) > 0.5 ? " − claimable on vendor bills " + fmt(g.claimable) : "") + ". Paid with your monthly GST return.";
    oweRow(ul2, num(g.credit) > 0.5 ? "GST credit (this event)" : "GST to pay (this event)", gsub, num(g.credit) > 0.5 ? g.credit : g.to_pay, fmt, { href: href("gst"), label: "Tax by month" });
    if (num(g.vendor_tds) > 0.5) oweRow(ul2, "TDS you deducted from vendors", "Deposit it with the tax office (challan) by the 7th of next month.", g.vendor_tds, fmt);
    s.appendChild(ul2);
    if (!num(cr.total) && !(cm.items || []).length && !(rf.items || []).length) s.appendChild(el("p", "mh-muted", "No wages, pay-backs or refunds to pay on this event."));
    cols.appendChild(s);
    box.appendChild(cols);
  }

  global.HelmMoneyCash = { renderCash: renderCash, renderOwes: renderOwes, dparts: dparts, daysBetween: daysBetween, whenWords: whenWords, how: how,
    split: split, rowChip: rowChip, explainRows: explainRows, waText: waText, actHref: actHref, chartModel: chartModel };
})(typeof window !== "undefined" ? window : globalThis);
