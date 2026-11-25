/* money-header-ui.js - R197 P&L clarity phase 1 (0376). The one-glance money header of an event, the same on Budget,
   Settlement, Closure and the event page:
     header     Quoted · Received (bar) · Costs (Expected before close, Actual after) vs Plan · Profit + margin with the
                traffic light against the studio target, the status chip ("In 5 days", "Closed · Frozen v2"), one sentence
                that names the gap ("5 points below your 25% target, mainly Decor & flowers (+32,000) and ...") and the rule
                "Profit = revenue without GST minus every cost of this event"
     attention  "Needs attention": at most 3 cards (bill to pay, money to collect, margin below target, ...)
     pva        Plan vs actual by category: Plan / Actual (or Expected) / Difference / a bar with the plan line, the studio's
                big-gap flag (Settings -> Money rules), tap a row for the lines behind it; "How the profit is worked out"
     cash/owes  R198 (0377): "Cash in & out" and "Who owes what" (money-cash-ui.js, event_money_cash), shown as tabs next to
                Plan vs actual when the page asks for them; hidden on a database without 0377 (the other parts still show)
   Mount: <div data-mh-mount data-mh-parts="header attention pva cash owes" data-mh-replaces="id1 id2" hidden></div>. It fills once
   the page shows its gate (data-mh-gate, default #app) and only for roles with Finance view; the server re-checks it
   (event_money_header). Without Finance view, on a database without 0376, or for an event that is not found, it stays
   hidden and the page's older cards keep working. Words: only Plan / Expected / Actual / Profit.
   The server does every sum; this file only formats. DOM via createElement / textContent only. Every amount carries
   data-money so privacy mode masks it. */
(function (global) {
  "use strict";
  var S = function () { return global.BPStore; };
  var SVGNS = "http://www.w3.org/2000/svg";
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; }
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); }
  function money(node) { node.setAttribute("data-money", ""); return node; }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function has(v) { return v !== null && v !== undefined && v !== ""; }
  function qid() { var p = new URLSearchParams(global.location.search); return p.get("quote") || p.get("id") || ""; }

  // ---------------- pure helpers (unit-tested in test/r197-money-header.test.mjs) ----------------
  // 5 -> "5", 4.5 -> "4.5", 1 -> "1"
  function pnum(n) { var r = Math.round(num(n) * 10) / 10; return String(r).replace(/\.0$/, ""); }
  function points(n) { var t = pnum(Math.abs(num(n))); return t + (t === "1" ? " point" : " points"); }
  function plural(n, one, many) { return num(n) === 1 ? one : many; }
  function lightLabel(light, loss) {
    if (light === "good") return "On target";
    if (light === "warn") return "Just below target";
    if (light === "bad") return loss ? "Loss" : "Well below target";
    return "No price yet";
  }
  // R257: an event with a price and no cost at all (no refund either) keeps 100% only on paper: neutral, never "On target"
  function noCosts(h) { return !!h && h.light !== "none" && num(h.revenue) > 0 && !(num(h.costs) > 0) && !(num(h.refunds) > 0); }
  // "today" / "tomorrow" / "in 4 days" / "yesterday" / "3 days ago"
  function whenWords(days) {
    if (!has(days)) return "";
    var d = Math.round(num(days));
    if (d === 0) return "today"; if (d === 1) return "tomorrow"; if (d === -1) return "yesterday";
    return d > 0 ? "in " + d + " days" : Math.abs(d) + " days ago";
  }
  // the chip next to the title
  function statusChip(h) {
    h = h || {};
    if (h.status === "cancelled") return { kind: "bad", text: "Cancelled", lock: false };
    if (h.closed) {
      var f = h.frozen && typeof h.frozen === "object" ? h.frozen : null;
      return f ? { kind: "good", text: "Closed · Frozen v" + num(f.version), lock: true } : { kind: "", text: "Closed", lock: false };
    }
    if (!has(h.days_to_event)) return { kind: "", text: "No event date", lock: false };
    var d = Math.round(num(h.days_to_event));
    if (d === 0) return { kind: "warn", text: "Event today", lock: false };
    if (d > 0) return { kind: "info", text: d === 1 ? "Event tomorrow" : "In " + d + " days", lock: false };
    return { kind: "", text: "Event " + whenWords(d) + " · not closed", lock: false };
  }
  // the sentence under the header as parts [{t, b, m}] (b = bold, m = an amount to mask in privacy mode)
  function sentence(h, fmt) {
    h = h || {}; fmt = fmt || function (n) { return String(Math.round(num(n))); };
    var out = [], add = function (t, b, m) { out.push({ t: t, b: !!b, m: !!m }); };
    var signed = function (n) { return (num(n) >= 0 ? "+" : "−") + fmt(Math.abs(num(n))); };
    if (h.light === "none" || !(num(h.revenue) > 0)) { add("This event has no price yet, so there is no profit to show. Price the quote first."); return out; }
    if (noCosts(h)) { add(h.closed ? "No costs were recorded on this event, so there is no real profit to compare with your " + pnum(h.target_pct) + "% target." : "No costs added yet. Add the budget lines, vendors and crew to see what you will keep."); return out; }
    var profit = num(h.profit), m = pnum(h.margin_pct), target = pnum(h.target_pct), gap = num(h.gap_points);
    var reasons = (h.reasons || []).filter(function (r) { return r && num(r.amount) > 0; }).slice(0, 2);
    function why(lead, alt) {
      if (!reasons.length) {
        if (has(h.plan_margin_pct) && num(h.plan_margin_pct) < num(h.target_pct)) { add(alt + (alt ? "the plan" : "The plan") + " itself was below the target ("); add(pnum(h.plan_margin_pct) + "%", true); add(")."); }
        else if (alt) add(".");
        return;
      }
      add(lead);
      reasons.forEach(function (r, i) {
        if (i) add(" and ");
        add(r.label || r.key, true); add(" ("); add(signed(r.amount), false, true); add(")");
      });
      add(".");
    }
    if (h.closed) {
      if (profit < 0) { add("This event lost "); add(fmt(Math.abs(profit)), true, true); add(". "); why("Mainly ", ""); return out; }
      add("You kept "); add(fmt(profit), true, true); add(" from this event ("); add(m + "%", true); add(" margin). ");
    } else {
      if (profit < 0) { add("If everything goes as booked this event loses "); add(fmt(Math.abs(profit)), true, true); add(". "); why("Mainly ", ""); add(" There is still time to fix it."); return out; }
      add("If everything goes as booked you will keep "); add(fmt(profit), true, true); add(" ("); add(m + "%", true); add("). ");
      if (has(h.plan_margin_pct)) add("You planned " + pnum(h.plan_margin_pct) + "%. ");
    }
    if (gap > 0) { add("That is "); add(points(gap) + " below", true); add(" your " + target + "% target"); why(", mainly ", ": "); }
    else add("That is at or above your " + target + "% target.");
    if (!h.closed && gap > 0 && reasons.length) add(" There is still time to fix it.");
    return out;
  }
  // one "Needs attention" card -> { level, title: parts, sub }
  function attention(a, fmt) {
    a = a || {}; fmt = fmt || function (n) { return String(Math.round(num(n))); };
    var T = [], add = function (t, m) { T.push({ t: t, m: !!m }); }, sub = "";
    switch (a.kind) {
      case "bill_due":
        add("Pay " + (a.who || "the vendor") + " "); add(fmt(a.amount), true);
        if (has(a.days)) add(num(a.days) < 0 ? " · overdue by " + Math.abs(Math.round(num(a.days))) + " " + plural(Math.abs(Math.round(num(a.days))), "day", "days") : " " + whenWords(a.days));
        sub = num(a.count) > 1 ? (num(a.count) - 1) + " more vendor " + plural(num(a.count) - 1, "bill", "bills") + " open on this event." : (has(a.days) ? "Vendor bill still open." : "Vendor bill still open (no due date).");
        break;
      case "collect":
        add("Collect "); add(fmt(a.amount), true); add(" from the client");
        if (has(a.days) && num(a.days) < 0) sub = (a.label ? a.label + " was due " : "Payment was due ") + whenWords(a.days) + ".";
        else if (has(a.days)) sub = (a.label || "Next payment") + " due " + whenWords(a.days) + ".";
        else sub = "Balance still owed.";
        sub += " Record it on Payments & invoice.";
        break;
      case "margin":
        if (a.loss) add("This event is making a loss");
        else add("Profit " + pnum(a.margin) + "% is below your " + pnum(a.target) + "% target");
        sub = a.loss ? "Costs are more than the revenue without GST." : points(a.gap) + " below. Plan vs actual shows where it went.";
        break;
      case "over_plan":
        add(num(a.count) + " " + plural(a.count, "category", "categories") + " well over the plan");
        if (a.top) { sub = "Biggest: " + (a.top.label || a.top.key) + " "; }
        break;
      case "unplanned":
        add("Unplanned spends "); add(fmt(a.amount), true);
        sub = num(a.count) + " cost " + plural(a.count, "line was", "lines were") + " added on or after the event day with no plan.";
        break;
      case "damage":
        add("Damage & loss "); add(fmt(a.amount), true); add(" counted as a cost");
        sub = "Decide on the Inventory page: the studio absorbs it or the client pays.";
        break;
      case "attendance":
        add("Confirm crew attendance (" + num(a.count) + " " + plural(a.count, "person", "people") + ")");
        sub = "So the wages in the profit are final (Closure page).";
        break;
      default: add(String(a.kind || "Check this event"));
    }
    return { level: a.level === "bad" || a.level === "warn" ? a.level : "info", title: T, sub: sub, top: a.kind === "over_plan" && a.top ? a.top : null };
  }
  // a category row's chip: { kind: bad | warn | good | "", text }
  function chip(c, fmt) {
    c = c || {}; fmt = fmt || function (n) { return String(Math.round(num(n))); };
    if (c.plan_only) return { kind: "", text: "Plan only" };
    var d = num(c.diff), plan = num(c.plan);
    if (c.flag === "over") return plan > 0 ? { kind: "bad", text: "Over by " + Math.round(num(c.diff_pct)) + "%" } : { kind: "bad", text: "Unplanned" };
    if (c.flag === "new") return { kind: "warn", text: "Unplanned" };
    if (c.flag === "watch") return { kind: "warn", text: "Watch +" + Math.round(num(c.diff_pct)) + "%" };
    if (c.flag === "under" || d < -0.5) return { kind: "good", text: "Saved " + fmt(Math.abs(d)), m: true };
    return { kind: "", text: "" };
  }

  // ---------------- DOM pieces ----------------
  function svg(path, cls) {
    var s = document.createElementNS(SVGNS, "svg"); s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("fill", "none");
    s.setAttribute("stroke", "currentColor"); s.setAttribute("stroke-width", "2"); s.setAttribute("stroke-linecap", "round");
    s.setAttribute("stroke-linejoin", "round"); s.setAttribute("aria-hidden", "true"); if (cls) s.setAttribute("class", cls);
    var p = document.createElementNS(SVGNS, "path"); p.setAttribute("d", path); s.appendChild(p); return s;
  }
  var I = { caret: "M9 6l6 6-6 6", lock: "M6 11h12v9H6zM9 11V8a3 3 0 0 1 6 0v3" };
  function parts(box, list) {
    list.forEach(function (p) {
      var n = p.b ? el("b", null, p.t) : (p.m ? el("span", null, p.t) : document.createTextNode(p.t));
      if (p.m) money(n);
      box.appendChild(n);
    });
    return box;
  }
  function kpi(label, value, sub, o) {
    o = o || {};
    var k = el("div", "mh-kpi" + (o.cls ? " " + o.cls : ""));
    k.appendChild(el("div", "mh-l", label));
    var n = money(el("div", "mh-n" + (o.neg ? " neg" : ""), value)); k.appendChild(n);
    if (sub) { var s = el("div", "mh-s"); if (typeof sub === "string") s.textContent = sub; else s.appendChild(sub); k.appendChild(s); }
    if (o.bar != null) {
      var bar = el("div", "mh-bar"); bar.setAttribute("role", "meter"); bar.setAttribute("aria-valuemin", "0"); bar.setAttribute("aria-valuemax", "100");
      bar.setAttribute("aria-valuenow", String(Math.round(o.bar))); bar.setAttribute("aria-label", o.barLabel || "Share received");
      var i = el("i"); i.style.width = Math.max(0, Math.min(100, num(o.bar))) + "%"; bar.appendChild(i); k.appendChild(bar);
    }
    return k;
  }
  function signedFmt(fmt, n) { return (num(n) > 0 ? "+" : num(n) < 0 ? "−" : "") + fmt(Math.abs(num(n))); }

  function renderHeader(box, h, fmt) {
    var sec = el("section", "mh-hero card"); sec.setAttribute("aria-label", "Event money at a glance");
    var top = el("div", "mh-top");
    var tt = el("div", "mh-tt"); tt.appendChild(el("h2", null, "Money at a glance"));
    top.appendChild(tt);
    var st = statusChip(h), c = el("span", "mh-chip" + (st.kind ? " " + st.kind : ""));
    if (st.lock) c.appendChild(svg(I.lock, "mh-ic"));
    c.appendChild(document.createTextNode(st.text)); top.appendChild(c);
    sec.appendChild(top);

    var grid = el("div", "mh-grid"), taxed = num(h.tax) > 0;
    var qsub = taxed ? fmt(h.revenue) + " + " + fmt(h.tax) + " GST" : "No GST on this event";
    var qs = money(el("span", null, qsub));
    grid.appendChild(kpi(taxed ? "Quoted (with GST)" : "Quoted", fmt(h.quoted), qs));
    var rsub = num(h.balance) > 0 ? fmt(h.balance) + " still to come" : (num(h.quoted) > 0 ? "Fully paid" : "Nothing to collect yet");
    if (num(h.client_tds) > 0) rsub += " · TDS " + fmt(h.client_tds);
    grid.appendChild(kpi("Received", fmt(h.received), money(el("span", null, rsub)), { bar: num(h.received_pct), barLabel: "Share of the bill received" }));
    var actual = h.cost_word === "actual";
    var same = Math.abs(num(h.costs_diff)) <= 0.5;   // R262 (owner: "don't repeat stuff here"): the plan is only said when it is another number
    var cs = el("span"); if (same) cs.appendChild(document.createTextNode("As planned")); else cs.appendChild(document.createTextNode("Plan was "));
    if (!same) cs.appendChild(money(el("span", null, fmt(h.costs_plan))));
    if (Math.abs(num(h.costs_diff)) > 0.5) { cs.appendChild(document.createTextNode(" · ")); cs.appendChild(money(el("span", num(h.costs_diff) > 0 ? "over" : "under", signedFmt(fmt, h.costs_diff)))); }
    grid.appendChild(kpi(actual ? "Actual costs" : "Expected costs", fmt(h.costs), cs));
    var ps = el("span", "mh-ps"), loss = num(h.profit) < 0;
    var lt = el("span", "mh-light " + (h.light === "good" || h.light === "warn" || h.light === "bad" ? h.light : "none"));
    if (noCosts(h)) { lt.className = "mh-light none"; lt.textContent = h.closed ? "No costs recorded" : "No costs added yet"; }
    else lt.textContent = (has(h.margin_pct) ? pnum(h.margin_pct) + "% · " : "") + lightLabel(h.light, loss);
    ps.appendChild(lt); ps.appendChild(el("span", "mh-tg", "target " + pnum(h.target_pct) + "%"));
    grid.appendChild(kpi(actual ? "Profit" : "Expected profit", (loss ? "−" : "") + fmt(Math.abs(num(h.profit))), ps, { cls: "profit", neg: loss }));
    sec.appendChild(grid);

    if (!(same && !h.closed && num(h.revenue) > 0 && !noCosts(h) && num(h.profit) >= 0 && num(h.gap_points) <= 0)) sec.appendChild(parts(el("p", "mh-sentence"), sentence(h, fmt)));
    if (h.frozen && typeof h.frozen === "object" && h.live_differs) {
      var lw = el("p", "mh-note warn"); lw.setAttribute("role", "note");
      lw.appendChild(document.createTextNode("Frozen v" + num(h.frozen.version) + " figure. Live numbers now say "));
      lw.appendChild(money(el("b", null, fmt(h.live_profit))));
      lw.appendChild(document.createTextNode(" (something changed after closing). The frozen figure stays; re-open and close again to freeze the new numbers."));
      sec.appendChild(lw);
    }
    if (h.rules === "legacy") sec.appendChild(el("p", "mh-note", "Closed before the new margin rules: the profit is the number recorded then."));
    sec.appendChild(el("p", "mh-rule", "Profit = revenue without GST minus every cost of this event (vendors, crew, stock loss, expenses). Before rent and salaries. GST you collect is not profit."));
    box.appendChild(sec);
  }

  function renderAttention(box, h, fmt, onTop, onOwes) {
    var list = (h.attention || []).slice(0, 3);
    if (!list.length) return;
    var sec = el("section", "mh-attn"); sec.setAttribute("aria-label", "Needs attention");
    sec.appendChild(el("h3", "sr-only", "Needs attention"));
    list.forEach(function (a) {
      var x = attention(a, fmt), card = el("div", "mh-a " + x.level);
      var t = el("b"); x.title.forEach(function (p) { var n = p.m ? money(el("span", null, p.t)) : document.createTextNode(p.t); t.appendChild(n); });
      card.appendChild(t);
      var s = el("span", null, x.sub);
      if (x.top) { s.appendChild(money(el("span", null, signedFmt(fmt, x.top.amount)))); s.appendChild(document.createTextNode(". Tap it in Plan vs actual to see the bills.")); }
      card.appendChild(s);
      if (x.top && typeof onTop === "function") { card.classList.add("tap"); card.tabIndex = 0; card.setAttribute("role", "button");
        var go = function () { onTop(x.top.key); };
        card.addEventListener("click", go); card.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } }); }
      // R198 (0377): "Pay ..." / "Collect ..." opens Who owes what when the page has it
      else if ((a.kind === "bill_due" || a.kind === "collect") && typeof onOwes === "function") { card.classList.add("tap"); card.tabIndex = 0; card.setAttribute("role", "button");
        card.setAttribute("aria-label", t.textContent + ". Open Who owes what");
        card.addEventListener("click", onOwes); card.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOwes(); } }); }
      sec.appendChild(card);
    });
    box.appendChild(sec);
  }

  var STAGE = { plan: "Plan", expected: "Expected", actual: "Actual" };
  function renderPva(box, h, fmt, state) {
    var actual = h.cost_word === "actual", word = actual ? "Actual" : "Expected";
    var sec = el("section", "mh-pva card " + (actual ? "is-actual" : "is-expected")); sec.setAttribute("aria-label", "Plan vs " + word.toLowerCase() + " by category");
    sec.appendChild(el("h2", null, "Plan vs " + word.toLowerCase() + " by category"));
    sec.appendChild(el("p", "sub", actual ? "What you planned against what it really cost. Tap a row to see the bills and lines behind it."
      : "Before the event is closed, Expected = actual where a bill, attendance or receipt is in, else what you agreed, else the plan. Tap a row to see the lines."));
    var cats = h.categories || [], lines = h.lines || [], max = 0;
    cats.forEach(function (c) { max = Math.max(max, num(c.plan), num(c.expected)); });
    var head = el("div", "mh-ph"); head.setAttribute("aria-hidden", "true");
    ["Category", "Plan", word, "Difference", "Spent vs plan"].forEach(function (t, i) { head.appendChild(el("span", i > 0 && i < 4 ? "num" : null, t)); });
    sec.appendChild(head);
    if (!cats.length) sec.appendChild(el("p", "mh-empty", "No costs yet - add budget lines, vendor bookings or crew to see plan vs " + word.toLowerCase() + "."));
    cats.forEach(function (c, idx) {
      var ch = chip(c, fmt), d = num(c.diff), open = !!state.open[c.key], did = "mh-d-" + (state.uid) + "-" + idx;
      var row = el("button", "mh-r"); row.type = "button"; row.setAttribute("aria-expanded", open ? "true" : "false"); row.setAttribute("aria-controls", did);
      row.setAttribute("data-cat", c.key);
      var cat = el("span", "mh-cat"); cat.appendChild(svg(I.caret, "mh-caret")); cat.appendChild(el("span", "mh-cn", c.label || c.key));
      if (ch.text) { var cp = el("span", "mh-chip" + (ch.kind ? " " + ch.kind : ""), ch.text); if (ch.m) money(cp); cat.appendChild(cp); }
      row.appendChild(cat);
      row.appendChild(money(el("span", "num mh-pl", fmt(c.plan))));
      row.appendChild(money(el("span", "num mh-ac", fmt(c.expected))));
      row.appendChild(money(el("span", "num mh-df" + (d > 0.5 ? " over" : d < -0.5 ? " under" : ""), Math.abs(d) <= 0.5 ? "-" : signedFmt(fmt, d))));
      var trk = el("span", "mh-trk"), tr = el("span", "mh-track"); tr.setAttribute("aria-hidden", "true");
      var fill = el("i", c.flag === "over" ? "over" : (c.flag === "watch" || c.flag === "new") ? "watch" : null);
      fill.style.width = (max > 0 ? Math.max(0, Math.min(100, num(c.expected) / max * 100)) : 0) + "%"; tr.appendChild(fill);
      if (num(c.plan) > 0 && max > 0) { var pl = el("b"); pl.style.left = "calc(" + Math.min(100, num(c.plan) / max * 100) + "% - 1px)"; tr.appendChild(pl); }
      trk.appendChild(tr); row.appendChild(trk);
      sec.appendChild(row);
      var det = el("div", "mh-det"); det.id = did; det.hidden = !open;
      var mine = lines.filter(function (l) { return l.category === c.key; });
      if (!mine.length) det.appendChild(el("p", "mh-muted", "No lines."));
      mine.forEach(function (l) {
        var ln = el("div", "mh-line"), left = el("span", "mh-lw");
        left.appendChild(el("span", null, l.label || "Cost"));
        left.appendChild(el("span", "mh-src", " · " + (STAGE[l.stage] || "Plan") + (l.unplanned ? " · Unplanned" : "")));
        if (l.note) left.appendChild(el("span", "mh-lnote", l.note));
        ln.appendChild(left);
        var r = el("span", "mh-lr"); r.appendChild(money(el("span", "num", fmt(l.expected))));
        if (num(l.plan) > 0 && Math.abs(num(l.plan) - num(l.expected)) > 0.5) { var pp = el("span", "mh-lp"); pp.appendChild(document.createTextNode("plan ")); pp.appendChild(money(el("span", null, fmt(l.plan)))); r.appendChild(pp); }
        ln.appendChild(r); det.appendChild(ln);
      });
      sec.appendChild(det);
      row.addEventListener("click", function () {
        var o = row.getAttribute("aria-expanded") !== "true";
        row.setAttribute("aria-expanded", o ? "true" : "false"); det.hidden = !o; state.open[c.key] = o;
      });
    });
    var tot = el("div", "mh-r mh-tot"), td = num(h.costs_diff);
    tot.appendChild(el("span", "mh-cat", "Total costs"));
    tot.appendChild(money(el("span", "num mh-pl", fmt(h.costs_plan))));
    tot.appendChild(money(el("span", "num mh-ac", fmt(h.costs))));
    tot.appendChild(money(el("span", "num mh-df" + (td > 0.5 ? " over" : td < -0.5 ? " under" : ""), Math.abs(td) <= 0.5 ? "-" : signedFmt(fmt, td))));
    var pt = el("span", "mh-trk mh-muted"); if (Math.abs(td) > 0.5) { pt.appendChild(document.createTextNode("Profit ")); pt.appendChild(money(el("span", null, fmt(h.plan_profit))));
    pt.appendChild(document.createTextNode(" planned → ")); pt.appendChild(money(el("span", null, fmt(h.profit)))); }
    tot.appendChild(pt); sec.appendChild(tot);
    var lg = el("div", "mh-legend");
    var gr = h.gap_rule || {};
    [["ok", "Within plan"], ["watch", "A little over / unplanned"], ["over", "Over by " + pnum(gr.pct != null ? gr.pct : 10) + "% or more than ", fmt(gr.abs != null ? gr.abs : 10000)], ["plan", "Plan line"]].forEach(function (x) {
      var s = el("span"); s.appendChild(el("i", "mh-k " + x[0])); s.appendChild(document.createTextNode(x[1]));
      if (x[2]) s.appendChild(money(el("span", null, x[2])));
      lg.appendChild(s);
    });
    sec.appendChild(lg);
    if (h.pay_private && lines.some(function (l) { return l.source === "crew"; })) sec.appendChild(el("p", "mh-muted", "Crew wages are one line: per-person pay is visible to the studio admin only."));

    // how the profit is worked out: the same lines everywhere
    var how = el("div", "mh-how"); how.appendChild(el("h3", null, "How the profit is worked out"));
    var g = el("div", "mh-steps");
    function step(l, v, s, o) { o = o || {}; var d = el("div", "mh-step"); d.appendChild(el("div", "mh-l", l)); var n = el("div", "mh-n", v); if (!o.plain) money(n); d.appendChild(n); if (s) d.appendChild(el("div", "mh-muted", s)); g.appendChild(d); }
    var tax = num(h.tax), rev = num(h.revenue);
    step(tax > 0 ? "Client pays (with GST)" : "Client pays", fmt(rev + tax));
    if (tax > 0) step("− GST collected", fmt(tax), "Paid to the government. Not yours.");
    step("= Revenue", fmt(rev), "without GST");
    if (num(h.refunds) > 0) step("− Refunds", fmt(h.refunds), "given back to the client, without GST");
    step("− Costs", fmt(h.costs), (h.categories || []).length + " " + plural((h.categories || []).length, "category", "categories") + " above");
    step("= Profit", (num(h.profit) < 0 ? "−" : "") + fmt(Math.abs(num(h.profit))), has(h.margin_pct) ? pnum(h.margin_pct) + "% of revenue" : "");
    step("Your target", pnum(h.target_pct) + "%", h.target_set ? "Set in Settings" : "Default - set yours in Settings", { plain: true });
    how.appendChild(g); sec.appendChild(how);
    box.appendChild(sec);
  }

  // R198 (0377): the tab bar under Needs attention (Plan vs actual · Cash in & out · Who owes what), as in mockups/pnl.
  // Each panel is drawn the first time it is opened (the chart measures its width). Keyboard: arrows move between tabs.
  function renderTabs(box, tabs, state, pref) {
    var hash = String((global.location && global.location.hash) || "").replace(/^#/, "");
    var pick = function (k) { return tabs.some(function (t) { return t.key === k; }) ? k : null; };
    var cur = pick(state.tab) || pick(hash) || pick(pref) || tabs[0].key;
    var bar = el("div", "mh-tabs"); bar.setAttribute("role", "tablist"); bar.setAttribute("aria-label", "Event money");
    var wrap = el("div", "mh-panels"), btns = {}, panels = {}, drawn = {};
    tabs.forEach(function (t) {
      var b = el("button", null, t.label); b.type = "button"; b.setAttribute("role", "tab"); b.id = "mh-tab-" + state.uid + "-" + t.key;
      b.setAttribute("aria-controls", "mh-pan-" + state.uid + "-" + t.key); b.setAttribute("data-tab", t.key);
      if (t.count) b.appendChild(el("span", "mh-count", t.count));
      var p = el("div", "mh-panel"); p.id = "mh-pan-" + state.uid + "-" + t.key; p.setAttribute("role", "tabpanel"); p.setAttribute("aria-labelledby", b.id);
      b.addEventListener("click", function () { select(t.key); });
      b.addEventListener("keydown", function (e) {
        var i = tabs.indexOf(t), j = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : null;
        if (j === null) return; e.preventDefault(); j = (j + tabs.length) % tabs.length; select(tabs[j].key); try { btns[tabs[j].key].focus(); } catch (x) {}
      });
      btns[t.key] = b; panels[t.key] = p; bar.appendChild(b); wrap.appendChild(p);
    });
    function select(k, scroll) {
      if (!btns[k]) return;
      state.tab = k;
      tabs.forEach(function (t) {
        var on = t.key === k; btns[t.key].setAttribute("aria-selected", on ? "true" : "false"); btns[t.key].tabIndex = on ? 0 : -1; panels[t.key].hidden = !on;
        if (on && !drawn[t.key]) { drawn[t.key] = true; t.draw(panels[t.key]); }
      });
      if (scroll) { try { bar.scrollIntoView({ block: "start", behavior: "smooth" }); } catch (e) {} }
    }
    box.appendChild(bar); box.appendChild(wrap);
    select(cur);
    return { select: select };
  }

  // ---------------- mount ----------------
  async function fmtFor(quoteId) {
    var B = S(), cfg = null;
    if (quoteId) { try { var ev = await B.quotes.get(quoteId); cfg = ev ? B.quoteTax(ev) : null; } catch (e) { cfg = null; } }
    return function (n) { try { return cfg ? B.quoteMoney(n, cfg) : B.studioMoney(n); } catch (e) { return String(Math.round(Number(n) || 0)); } };
  }
  var uid = 0;
  async function mount(box) {
    var B = S(); if (!B || !B.moneyHeader) { box.hidden = true; return; }
    var id = qid();
    if (global.HelmPageQuote && typeof global.HelmPageQuote.then === "function") {   // event.html: wait for the page's own check
      try { var pq = await global.HelmPageQuote; if (!pq) { box.hidden = true; return; } id = String(pq); } catch (e) { box.hidden = true; return; }
    }
    if (!id) { box.hidden = true; return; }
    var fin = false; try { fin = await B.auth.canView("finance"); } catch (e) { fin = false; }
    if (!fin) { box.hidden = true; return; }      // no money numbers for this role; the page shows the rest
    // R249 (0431): every money card of this page in ONE call (the ledger is built once, never three times side by side)
    try { if (B.moneyOnce && B.moneyOnce.wantPage) B.moneyOnce.wantPage(id); } catch (e) {}
    var want = String(box.getAttribute("data-mh-parts") || "header attention").split(/\s+/);
    var replaces = String(box.getAttribute("data-mh-replaces") || "").split(/\s+/).filter(Boolean);
    var fmt = await fmtFor(id), seq = 0, timer = null, state = { open: {}, uid: ++uid, tab: null }, started = Date.now();
    var wantCash = want.indexOf("cash") >= 0, wantOwes = want.indexOf("owes") >= 0;
    async function draw() {
      var my = ++seq, h, c = null;
      var pc = (wantCash || wantOwes) && B.moneyCash ? Promise.resolve().then(function () { return B.moneyCash.get(id); }).catch(function () { return null; }) : Promise.resolve(null);
      try { h = await B.moneyHeader.get(id); } catch (e) { h = null; }
      try { c = await pc; } catch (e) { c = null; }
      if (my !== seq) return;
      if (!h || typeof h !== "object") { box.hidden = true; return; }     // older database / not found: the older cards stay
      replaces.forEach(function (rid) { var n = document.getElementById(rid); if (n) n.hidden = true; });
      clear(box); box.classList.add("mh-wrap"); box.hidden = false;   // shown before the tabs draw: the chart measures its width
      if (want.indexOf("header") >= 0) renderHeader(box, h, fmt);
      var C = global.HelmMoneyCash, hasCash = !!(c && typeof c === "object" && C);
      var tabs = [];
      if (want.indexOf("pva") >= 0) tabs.push({ key: "pva", label: "Plan vs " + (h.cost_word === "actual" ? "actual" : "expected"), draw: function (b) { renderPva(b, h, fmt, state); } });
      if (hasCash && wantCash) tabs.push({ key: "cash", label: "Cash in & out", draw: function (b) { C.renderCash(b, c, fmt); } });
      if (hasCash && wantOwes) {
        var o = c.owes || {}, cnt = ((o.vendors || {}).bills || []).length + ((o.claims || {}).items || []).length + ((o.refunds || {}).items || []).length + (num((o.client || {}).balance) > 0.5 ? 1 : 0);
        tabs.push({ key: "owes", label: "Who owes what", count: cnt, draw: function (b) { C.renderOwes(b, c, fmt, { here: function (hid) { return !!document.getElementById(hid); } }); } });
      }
      var tabsApi = null;
      if (want.indexOf("attention") >= 0) renderAttention(box, h, fmt, want.indexOf("pva") >= 0 ? function (key) {
        if (tabsApi) tabsApi.select("pva");
        state.open[key] = true; var r = box.querySelector('.mh-r[data-cat="' + String(key).replace(/[^a-z0-9_-]/gi, "") + '"]');
        if (r && r.getAttribute("aria-expanded") !== "true") r.click();
        if (r) { try { r.scrollIntoView({ block: "center", behavior: "smooth" }); r.focus({ preventScroll: true }); } catch (e) {} }
      } : null, tabs.some(function (t) { return t.key === "owes"; }) ? function () { if (tabsApi) tabsApi.select("owes", true); } : null);
      if (tabs.length === 1) { var one = el("div"); box.appendChild(one); tabs[0].draw(one); }
      else if (tabs.length > 1) tabsApi = renderTabs(box, tabs, state, box.getAttribute("data-mh-tab"));
      box.hidden = false;
    }
    var rz = null, lastW = 0;
    global.addEventListener && global.addEventListener("resize", function () {
      clearTimeout(rz); rz = setTimeout(function () { var w = global.innerWidth || 0; if (state.tab === "cash" && Math.abs(w - lastW) > 40) { lastW = w; draw(); } }, 250);
    });
    lastW = global.innerWidth || 0;
    function soon() { if (Date.now() - started < 1200) return; clearTimeout(timer); timer = setTimeout(draw, 250); }
    ["helm:pnl-refresh", "helm:vendor-bills-changed", "helm:settlement-loaded", "helm:money-changed"].forEach(function (ev) { document.addEventListener(ev, soon); });
    await draw();
  }
  function whenShown(gate, fn) {
    if (!gate) { fn(); return; }
    var done = false, run = function () { if (done || gate.hidden) return; done = true; obs.disconnect(); fn(); };
    var obs = new MutationObserver(run); obs.observe(gate, { attributes: true, attributeFilter: ["hidden"] }); run();
  }
  function start() {
    Array.prototype.forEach.call(document.querySelectorAll("[data-mh-mount]"), function (n) {
      var gid = n.getAttribute("data-mh-gate"), gate = gid === "none" ? null : document.getElementById(gid || "app");
      whenShown(gate, function () { Promise.resolve().then(function () { return mount(n); }).catch(function (e) { try { console.warn("money header:", e && e.message); } catch (_) {} n.hidden = true; }); });
    });
  }
  global.HelmMoneyHeader = { mount: mount, renderTabs: renderTabs, sentence: sentence, attention: attention, chip: chip, statusChip: statusChip, lightLabel: lightLabel, noCosts: noCosts,
    whenWords: whenWords, points: points, pnum: pnum, renderHeader: renderHeader, renderAttention: renderAttention, renderPva: renderPva };
  if (typeof document === "undefined") return;
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})(typeof window !== "undefined" ? window : globalThis);
