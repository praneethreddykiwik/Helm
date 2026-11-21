/* insights-overview.js - R240 Insights: "At a glance" (vs the period before), Sales funnel + lead sources + months,
 * Payments (overdue with ageing + how late clients pay), Coming up (next 30 days), Top packages, Cancellations, CSV export.
 * Data: BPStore.insights.overview(from, to) -> insights_overview (0405, read-only) + the ledger rows the page already has
 * (insights_event_costs = event_pnl) for every amount of revenue / profit - no new money math here, only sums of those rows.
 * Privacy ("Hide amounts"): every amount node carries data-money and reads "••••" while amounts are hidden (re-drawn when
 * the eye button is toggled); counts and percentages stay. Export is refused while amounts are hidden.
 * CSP: DOM via createElement / textContent only (no HTML strings, no style= attributes); bar sizes via the CSSOM.
 * Pure helpers (pct, delta, ledgerTotals, packageRevenue, marginsFromLedger, toCSV, csvRows) are exported for
 * test/r240-insights.test.mjs. */
(function (root) {
  "use strict";
  var MASK = "••••";
  var FORMULA = /^[\s 　]*[=+\-@\t\r＝＋－＠]/;   // R139 strong spreadsheet-formula guard

  /* ---------------- pure helpers ---------------- */
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function cur(r) { return String((r && r.currency) || "INR").toUpperCase(); }
  function pct(a, b) { a = num(a); b = num(b); return b > 0 ? Math.round(a / b * 100) : null; }
  function day(r) { return String((r && r.date) || "").slice(0, 10); }
  function inDays(r, from, to) { var d = day(r); return !!d && (!from || d >= from) && (!to || d <= to); }
  /* change vs the period before. kind: "count" (+3, +25%), "pct" (+4 pts), "money" (+12%). bad = up is bad (cancellations).
   * -> { dir: "up" | "down" | "same" | "new" | null, good: true | false | null, text } (null dir = nothing to compare) */
  function delta(now, before, kind, bad) {
    if (now == null || before == null) return { dir: null, good: null, text: "" };
    var a = Number(now), b = Number(before);
    if (!isFinite(a) || !isFinite(b)) return { dir: null, good: null, text: "" };
    var d = a - b, dir = d > 0 ? "up" : d < 0 ? "down" : "same";
    if (kind !== "pct" && b === 0 && a > 0) return { dir: "new", good: bad ? false : true, text: "new" };
    var good = dir === "same" ? null : ((dir === "up") !== !!bad);
    var text;
    if (dir === "same") text = "same";
    else if (kind === "pct") text = (d > 0 ? "+" : "") + Math.round(d) + " pts";
    else if (kind === "money") text = (d > 0 ? "+" : "") + Math.round(d / Math.abs(b) * 100) + "%";
    else text = (d > 0 ? "+" : "") + d + (b ? " (" + (d > 0 ? "+" : "") + Math.round(d / b * 100) + "%)" : "");
    return { dir: dir, good: good, text: text };
  }
  /* ledger totals per currency for the events dated in [from, to] - HelmInsightsCosts.moneyByCurrency when loaded
   * (the SAME function the Money tiles use), else the plain sums of the same rows */
  function ledgerTotals(rows, from, to) {
    var C = root.HelmInsightsCosts;
    if (C && typeof C.moneyByCurrency === "function") return C.moneyByCurrency(rows, from, to);
    var g = {};
    (rows || []).filter(function (r) { return inDays(r, from, to); }).forEach(function (r) {
      var c = cur(r), t = g[c] || (g[c] = { currency: c, events: 0, revenue_ex_tax: 0, profit: 0 });
      t.events++; t.revenue_ex_tax += num(r.revenue); t.profit += num(r.profit); });
    Object.keys(g).forEach(function (c) { g[c].margin_pct = pct(g[c].profit, g[c].revenue_ex_tax); });
    return g;
  }
  /* packages (overview ids) + ledger rows -> per package: events + ledger revenue / profit per currency */
  function packageRevenue(list, rows) {
    var by = {};
    (rows || []).forEach(function (r) { if (r && r.id != null) by[String(r.id)] = r; });
    return (list || []).map(function (p) {
      var money = {}, matched = 0;
      (p.ids || []).forEach(function (id) { var r = by[String(id)]; if (!r) return; matched++;
        var c = cur(r), m = money[c] || (money[c] = { currency: c, revenue: 0, profit: 0 });
        m.revenue = Math.round((m.revenue + num(r.revenue)) * 100) / 100; m.profit = Math.round((m.profit + num(r.profit)) * 100) / 100; });
      return { name: String(p.name || ""), events: num(p.events), matched: matched,
        money: Object.keys(money).sort().map(function (c) { return money[c]; }) };
    });
  }
  /* margin trend of CLOSED events from the ledger rows (same profit as every other card; was closure.pl per event) -
   * the shape BPStore.insights.summary().margins had */
  function marginsFromLedger(rows, from, to) {
    var list = (rows || []).filter(function (r) { return r && r.stage === "closed" && inDays(r, from, to); })
      .map(function (r) { return { id: r.id, code: r.code, date: day(r), profit: num(r.profit), revenue: num(r.revenue),
        marginPct: num(r.revenue) > 0 ? pct(r.profit, r.revenue) : null, currency: cur(r) }; })
      .sort(function (a, b) { return a.date.localeCompare(b.date) || String(a.code || "").localeCompare(String(b.code || "")); });
    var withRevenue = list.filter(function (x) { return x.revenue > 0; }), noRevenue = list.filter(function (x) { return !(x.revenue > 0); });
    var avg = function (l) { return l.length ? Math.round(l.reduce(function (a, x) { return a + (x.marginPct || 0); }, 0) / l.length) : null; };
    var g = {};
    list.forEach(function (x) { (g[x.currency] = g[x.currency] || []).push(x); });
    var byCurrency = Object.keys(g).map(function (c) { var l = g[c];
      return { currency: c, events: l.length, totalProfit: Math.round(l.reduce(function (a, x) { return a + x.profit; }, 0) * 100) / 100,
        revenue: Math.round(l.reduce(function (a, x) { return a + x.revenue; }, 0) * 100) / 100,
        avgMargin: avg(withRevenue.filter(function (x) { return x.currency === c; })) }; })
      .sort(function (a, b) { return b.events - a.events || a.currency.localeCompare(b.currency); });
    return { events: list, withRevenue: withRevenue, noRevenue: noRevenue,
      totalProfit: Math.round(list.reduce(function (a, x) { return a + x.profit; }, 0) * 100) / 100, avgMargin: avg(withRevenue), byCurrency: byCurrency };
  }
  function cell(v) {
    var isStr = typeof v === "string"; v = v == null ? "" : String(v);
    if (isStr && FORMULA.test(v)) v = "'" + v;
    return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }
  /* rows = arrays of cells; a null row = an empty line between sections */
  function toCSV(rows) { return (rows || []).map(function (r) { return r ? r.map(cell).join(",") : ""; }).join("\n"); }
  /* everything on screen as CSV rows (amounts only when finance; plain numbers, never "₹1,23,456") */
  function csvRows(d, rows, opts) {
    opts = opts || {};
    var out = [], f = (d && d.funnel) || {}, c = f.cur || {}, p = f.prev || {}, fin = !!(d && d.finance);
    var lbl = typeof opts.sourceLabel === "function" ? opts.sourceLabel : function (s) { return s; };
    out.push(["Helm Insights", (d && d.from) + " to " + (d && d.to), "previous period " + (d && d.prev_from) + " to " + (d && d.prev_to)]);
    out.push(null, ["Sales funnel", "This period", "Previous period"]);
    [["Enquiries", "enquiries"], ["Enquiries won", "enquiries_won"], ["Enquiries lost", "enquiries_lost"], ["Quotes made", "quotes_made"],
     ["Quotes confirmed", "quotes_won"], ["Quotes cancelled", "quotes_cancelled"], ["Quotes still open", "quotes_open"],
     ["Bookings confirmed", "bookings"], ["Cancellations", "cancellations"]].forEach(function (x) {
      if (c[x[1]] == null && p[x[1]] == null) return; out.push([x[0], c[x[1]], p[x[1]]]); });
    out.push(["Quote win rate %", pct(c.quotes_won, c.quotes_made), pct(p.quotes_won, p.quotes_made)]);
    if (c.enquiries != null) out.push(["Enquiry conversion %", pct(c.enquiries_won, c.enquiries), pct(p.enquiries_won, p.enquiries)]);
    if (fin && rows) {
      var a = ledgerTotals(rows, d.from, d.to), b = ledgerTotals(rows, d.prev_from, d.prev_to);
      Object.keys(a).concat(Object.keys(b)).filter(function (k, i, l) { return l.indexOf(k) === i; }).sort().forEach(function (k) {
        var x = a[k] || {}, y = b[k] || {};
        out.push(["Revenue ex-tax " + k, num(x.revenue_ex_tax), num(y.revenue_ex_tax)], ["Profit " + k, num(x.profit), num(y.profit)],
          ["Margin % " + k, x.margin_pct == null ? "" : x.margin_pct, y.margin_pct == null ? "" : y.margin_pct]); });
    }
    if (Array.isArray(d && d.sources) && d.sources.length) {
      out.push(null, ["Lead source", "Enquiries", "Won", "Lost", "Conversion %"]);
      d.sources.forEach(function (s) { out.push([s.source === "none" ? "Not recorded" : lbl(s.source), s.enquiries, s.won, s.lost, pct(s.won, s.enquiries)]); });
    }
    if (Array.isArray(d && d.months) && d.months.length) {
      out.push(null, ["Month", "Enquiries", "Quotes made", "Bookings"]);
      d.months.forEach(function (m) { out.push([m.month, m.enquiries == null ? "" : m.enquiries, m.quotes_made, m.bookings]); });
    }
    var pk = d && d.packages && Array.isArray(d.packages.list) ? packageRevenue(d.packages.list, rows) : [];
    if (pk.length) {
      out.push(null, fin ? ["Package", "Events", "Currency", "Revenue ex-tax", "Profit"] : ["Package", "Events"]);
      pk.forEach(function (x) { if (!fin || !x.money.length) out.push([x.name, x.events]);
        else x.money.forEach(function (m, i) { out.push([x.name, i ? "" : x.events, m.currency, m.revenue, m.profit]); }); });
    }
    var up = d && d.upcoming;
    if (up && Array.isArray(up.events) && up.events.length) {
      out.push(null, ["Coming up (next 30 days)", "Event", "Stage", "Guests", "Tasks", "Open tasks", "Unassigned tasks", "Crew"]);
      up.events.forEach(function (e) { out.push([e.date, (e.code || "") + (e.title ? " " + e.title : ""), e.stage, e.guests == null ? "" : e.guests, e.tasks, e.tasks_open, e.tasks_unassigned, e.crew]); });
    }
    var cx = d && d.cancellations;
    if (cx && Array.isArray(cx.reasons) && cx.reasons.length) {
      out.push(null, ["Cancellation reason", "Times"]);
      cx.reasons.forEach(function (r) { out.push([r.reason, r.count]); });
    }
    var od = fin && d.payments && d.payments.overdue;
    if (od && Array.isArray(od.list) && od.list.length) {
      out.push(null, ["Overdue payment (oldest first, first 10)", "Client", "Milestone", "Due", "Days late", "Currency", "Balance"]);
      od.list.forEach(function (o) { out.push([o.code || "", o.client || "", o.label || "", o.due_date, o.days_late, o.currency, num(o.balance)]); });
    }
    if (fin && rows) {
      var ev = rows.filter(function (r) { return inDays(r, d.from, d.to); });
      if (ev.length) {
        out.push(null, ["Event", "Date", "Currency", "Revenue ex-tax", "Cost", "Profit", "Margin %", "Collected", "Outstanding"]);
        ev.forEach(function (r) { out.push([(r.code || "") + (r.title && r.title !== r.code ? " " + r.title : ""), day(r), cur(r), num(r.revenue),
          num(r.cost_total), num(r.profit), r.margin_pct == null ? "" : r.margin_pct, num(r.collected), num(r.outstanding)]); });
      }
    }
    return out;
  }

  /* ---------------- DOM ---------------- */
  function H(tag, cls, text, parent) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    if (parent) parent.appendChild(n);
    return n;
  }
  function mount(hosts, ctx) {
    ctx = ctx || {};
    var st = { d: null, rows: null, msg: "", ledgerNote: "" };
    var hidden = function () { try { return typeof ctx.hidden === "function" && !!ctx.hidden(); } catch (e) { return false; } };
    var M = function (n, c) { return hidden() ? MASK : (typeof ctx.money === "function" ? ctx.money(n, c) : String(Math.round(num(n)))); };
    var money = function (tag, cls, n, c, parent) { var el = H(tag, cls, M(n, c), parent); el.setAttribute("data-money", ""); return el; };
    var fmtDate = function (s) { try { return typeof ctx.fmtDate === "function" ? ctx.fmtDate(s) : String(s || ""); } catch (e) { return String(s || ""); } };
    var href = function (id) { return typeof ctx.href === "function" ? ctx.href(id) : "event.html?id=" + encodeURIComponent(id || ""); };
    var srcLabel = function (s) { if (s === "none") return "Not recorded"; try { var l = typeof ctx.sourceLabel === "function" ? ctx.sourceLabel(s) : ""; if (l) return l; } catch (e) {} return String(s || ""); };
    var home = function () { try { return String((typeof ctx.studioCurrency === "function" && ctx.studioCurrency()) || "INR").toUpperCase(); } catch (e) { return "INR"; } };
    var empty = function (host, text) { host.textContent = ""; H("div", "empty io-empty", text, host); };
    function chip(parent, dl, prevText) {
      var w = H("div", "io-delta", null, parent);
      if (dl.dir) {
        var s = H("span", "io-chip io-" + dl.dir + (dl.good === true ? " io-good" : dl.good === false ? " io-bad" : ""), null, w);
        s.textContent = (dl.dir === "up" ? "▲ " : dl.dir === "down" ? "▼ " : "") + dl.text;
        s.setAttribute("aria-label", (dl.dir === "same" ? "no change" : dl.text) + " versus the previous period");
      }
      if (prevText != null) H("span", "io-prev", "before: " + prevText, w);
      return w;
    }
    function tile(parent, value, label, dl, prevText, opts) {
      opts = opts || {};
      var t = H("div", "kpi io-tile", null, parent);
      var v = H("div", "n" + (opts.cls ? " " + opts.cls : ""), value, t); if (opts.money) v.setAttribute("data-money", "");
      H("div", "l", label, t);
      var c = chip(t, dl, prevText); if (opts.money && prevText != null) c.lastChild.setAttribute("data-money", "");
      if (opts.hint) H("div", "h", opts.hint, t);
      return t;
    }
    function bar(parent, label, n, max, cls, text) {
      var row = H("div", "bar", null, parent);
      H("span", "lb", label, row).title = label;
      var tr = H("span", "track", null, row), f = H("span", "fill " + (cls || "c-accent"), null, tr);
      f.style.width = (max > 0 ? Math.max(n > 0 ? 4 : 0, Math.round(n / max * 100)) : 0) + "%";
      H("span", "v", text != null ? text : String(n), row);
      return row;
    }
    function table(parent, heads) {
      var sc = H("div", "tscroll", null, parent), t = H("table", "pe io-table", null, sc), hr = H("tr", null, null, H("thead", null, null, t));
      heads.forEach(function (h) { var th = H("th", h[1] || "", h[0], hr); th.scope = "col"; });
      return H("tbody", null, null, t);
    }

    function renderGlance() {
      var host = hosts.glance; if (!host) return; host.textContent = "";
      var d = st.d, f = (d && d.funnel) || {}, c = f.cur || {}, p = f.prev || {};
      var g = H("div", "kpis io-glance", null, host);
      if (d.leads) tile(g, String(num(c.enquiries)), "New enquiries", delta(c.enquiries, p.enquiries, "count"), String(num(p.enquiries)));
      tile(g, String(num(c.bookings)), "Bookings confirmed", delta(c.bookings, p.bookings, "count"), String(num(p.bookings)));
      var w = pct(c.quotes_won, c.quotes_made), wp = pct(p.quotes_won, p.quotes_made);
      tile(g, w == null ? "—" : w + "%", "Quote win rate", delta(w, wp, "pct"), wp == null ? "—" : wp + "%",
        { hint: num(c.quotes_won) + " of " + num(c.quotes_made) + " quotes made" });
      if (d.finance && st.rows) {
        var a = ledgerTotals(st.rows, d.from, d.to), b = ledgerTotals(st.rows, d.prev_from, d.prev_to), k = home();
        var keys = Object.keys(a); if (keys.indexOf(k) < 0 && keys.length) k = keys.sort()[0];
        var x = a[k] || { revenue_ex_tax: 0, profit: 0, margin_pct: null }, y = b[k] || { revenue_ex_tax: 0, profit: 0, margin_pct: null };
        var more = keys.filter(function (z) { return z !== k; });
        tile(g, M(x.revenue_ex_tax, k), "Revenue (ex-tax)" + (more.length ? " · " + k : ""), st.ledgerCut ? { dir: null } : delta(x.revenue_ex_tax, y.revenue_ex_tax, "money"),
          st.ledgerCut ? null : M(y.revenue_ex_tax, k), { money: true, hint: more.length ? "+ " + more.join(", ") + " shown in Money below" : "events dated in this period" });
        tile(g, M(x.profit, k), "Profit" + (x.margin_pct != null ? " · " + x.margin_pct + "% margin" : ""), st.ledgerCut ? { dir: null } : delta(x.profit, y.profit, "money"),
          st.ledgerCut ? null : M(y.profit, k), { money: true, cls: num(x.profit) < 0 ? "neg" : "pos", hint: "same profit as Settlement and Business" });
      }
      tile(g, String(num(c.cancellations)), "Cancellations", delta(c.cancellations, p.cancellations, "count", true), String(num(p.cancellations)));
      H("p", "note io-note", "Compared with " + fmtDate(d.prev_from) + " – " + fmtDate(d.prev_to) + " (the period just before, same length)." + (st.ledgerNote ? " " + st.ledgerNote : ""), host);
    }
    function renderFunnel() {
      var host = hosts.funnel; if (!host) return; host.textContent = "";
      var d = st.d, c = (d.funnel && d.funnel.cur) || {};
      var steps = [];
      if (d.leads) steps.push(["Enquiries", num(c.enquiries)]);
      steps.push(["Quotes made", num(c.quotes_made)], ["Bookings", num(c.bookings)]);
      var max = Math.max.apply(null, steps.map(function (s) { return s[1]; }).concat([1]));
      var fw = H("div", "io-funnel", null, host);
      steps.forEach(function (s, i) { bar(fw, s[0], s[1], max, i === steps.length - 1 ? "c-safe" : "c-accent"); });
      var facts = H("ul", "io-facts", null, host);
      if (d.leads) H("li", null, (c.enquiries ? pct(c.enquiries_won, c.enquiries) + "% of this period's enquiries are won so far (" + num(c.enquiries_won) + " won, "
        + num(c.enquiries_lost) + " lost, " + Math.max(0, num(c.enquiries) - num(c.enquiries_won) - num(c.enquiries_lost)) + " still open)." : "No new enquiries in this period."), facts);
      H("li", null, c.quotes_made ? "Quote win rate " + pct(c.quotes_won, c.quotes_made) + "%: of " + num(c.quotes_made) + " quotes made, " + num(c.quotes_won) + " confirmed, "
        + num(c.quotes_cancelled) + " cancelled, " + num(c.quotes_open) + " still open." : "No quotes made in this period.", facts);
      H("li", null, num(c.bookings) + " booking(s) confirmed in this period (whenever the quote was made).", facts);
      if (!d.leads) H("p", "note", "Enquiry numbers need access to Leads.", host);
      // lead sources
      if (d.leads) {
        H("h4", "io-h4", "Where enquiries come from", host);
        var src = Array.isArray(d.sources) ? d.sources : [];
        if (!src.length) H("div", "empty io-empty", "No enquiries in this period.", host);
        else {
          var tb = table(host, [["Source"], ["Enquiries", "n"], ["Won", "n"], ["Lost", "n"], ["Conversion", "n"]]);
          src.forEach(function (s) { var tr = H("tr", null, null, tb);
            H("td", null, srcLabel(s.source), tr); H("td", "n", String(num(s.enquiries)), tr); H("td", "n", String(num(s.won)), tr);
            H("td", "n", String(num(s.lost)), tr); var cv = pct(s.won, s.enquiries); H("td", "n", cv == null ? "—" : cv + "%", tr); });
        }
      }
      // month by month
      var ms = Array.isArray(d.months) ? d.months : [];
      if (ms.length > 1) {
        H("h4", "io-h4", "Month by month", host);
        var mx = Math.max.apply(null, ms.map(function (m) { return Math.max(num(m.enquiries), num(m.quotes_made), num(m.bookings)); }).concat([1]));
        var wrap = H("div", "io-months", null, H("div", "tscroll", null, host)); wrap.setAttribute("role", "img");
        wrap.setAttribute("aria-label", "Per month: " + ms.map(function (m) { return m.month + " " + (d.leads ? num(m.enquiries) + " enquiries, " : "") + num(m.quotes_made) + " quotes, " + num(m.bookings) + " bookings"; }).join("; "));
        var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        ms.forEach(function (m) {
          var col = H("div", "io-mcol", null, wrap), bars = H("div", "io-mbars", null, col);
          (d.leads ? [["enquiries", "io-b1"], ["quotes_made", "io-b2"], ["bookings", "io-b3"]] : [["quotes_made", "io-b2"], ["bookings", "io-b3"]]).forEach(function (k) {
            var b = H("span", "io-mb " + k[1], null, bars); b.style.height = Math.round(num(m[k[0]]) / mx * 100) + "%"; b.title = k[0].replace("_", " ") + ": " + num(m[k[0]]); });
          var pm = String(m.month || "").split("-"); H("span", "io-ml", (MON[+pm[1] - 1] || "") + " " + String(pm[0] || "").slice(2), col);
        });
        var lg = H("div", "legend io-legend", null, host);
        (d.leads ? [["io-b1", "Enquiries"], ["io-b2", "Quotes made"], ["io-b3", "Bookings"]] : [["io-b2", "Quotes made"], ["io-b3", "Bookings"]]).forEach(function (x) {
          var s = H("span", null, null, lg); H("i", x[0], null, s); s.appendChild(document.createTextNode(x[1])); });
      }
    }
    function renderPayments() {
      var card = hosts.payCard, host = hosts.pay; if (!host) return;
      var d = st.d, pay = d.payments;
      if (card) card.hidden = !d.finance;
      if (!d.finance || !pay) return;
      host.textContent = "";
      var od = pay.overdue || {}, bc = Array.isArray(od.by_currency) ? od.by_currency : [];
      var top = H("div", "io-od", null, host);
      if (!num(od.count)) H("div", "io-ok", "Nothing overdue today — every payment due so far has come in.", top);
      else {
        var big = H("div", "io-odn", null, top);
        H("b", null, num(od.count) + " payment" + (num(od.count) === 1 ? "" : "s") + " overdue", big);
        big.appendChild(document.createTextNode(" · "));
        bc.forEach(function (x, i) { if (i) big.appendChild(document.createTextNode(" · ")); money("b", "neg", x.balance, x.currency, big); });
        H("div", "muted", "Oldest " + Math.max.apply(null, bc.map(function (x) { return num(x.oldest_days); }).concat([0])) + " days late. Same list as Home → Overdue.", top);
        var ag = Array.isArray(od.ageing) ? od.ageing : [], k = home(), curs = bc.map(function (x) { return x.currency; });
        if (curs.indexOf(k) < 0) k = curs[0];
        var mx = Math.max.apply(null, ag.filter(function (a) { return a.currency === k; }).map(function (a) { return num(a.count); }).concat([1]));
        H("h4", "io-h4", "How late" + (curs.length > 1 ? " (" + k + ")" : ""), host);
        var aw = H("div", "io-age", null, host);
        ["1-7", "8-30", "31-60", "60+"].forEach(function (bk, i) {
          var a = ag.filter(function (x) { return x.bucket === bk && x.currency === k; })[0] || { count: 0, balance: 0 };
          var row = bar(aw, bk + " days", num(a.count), mx, i >= 2 ? "c-bad" : "c-warn", num(a.count) + " · ");
          var v = row.lastChild; var sp = H("span", null, M(a.balance, k), v); sp.setAttribute("data-money", "");
        });
        var tb = table(host, [["Event"], ["Client"], ["Milestone"], ["Due"], ["Late", "n"], ["Balance", "n"]]);
        (od.list || []).forEach(function (o) { var tr = H("tr", null, null, tb), td = H("td", null, null, tr), a = H("a", null, o.code || "Event", td); a.href = href(o.quote_id);
          if (o.title && o.title !== o.code) H("div", "io-sub", o.title, td);
          H("td", null, o.client || "—", tr); H("td", null, o.label || "", tr); H("td", null, fmtDate(o.due_date), tr);
          H("td", "n neg", num(o.days_late) + " d", tr); money("td", "n", o.balance, o.currency, tr); });
        if (num(od.count) > (od.list || []).length) H("p", "note", "Showing the 10 oldest of " + num(od.count) + ".", host);
      }
      var t = pay.timing || {}, tp = pay.timing_prev || {};
      H("h4", "io-h4", "How fast clients paid in this period", host);
      var tw = H("div", "io-timing", null, host);
      if (!num(t.paid)) H("div", "muted", "No payment milestone was marked paid in this period.", tw);
      else {
        var on = pct(t.on_time, t.paid), onp = pct(tp.on_time, tp.paid);
        var row = H("div", "io-trow", null, tw);
        H("b", null, on + "% on time", row);
        row.appendChild(document.createTextNode(" · " + num(t.paid) + " paid, " + num(t.late) + " late" + (t.avg_days_late != null ? " (on average " + t.avg_days_late + " days late)" : "")));
        chip(tw, delta(on, onp, "pct"), onp == null ? "—" : onp + "% on time");
      }
    }
    function renderUpcoming() {
      var host = hosts.upcoming; if (!host) return; host.textContent = "";
      var u = st.d.upcoming || {}, wk = Array.isArray(u.weeks) ? u.weeks : [], ev = Array.isArray(u.events) ? u.events : [];
      if (!num(u.total)) { H("div", "empty io-empty", "No confirmed events in the next 30 days.", host); return; }
      var sm = H("div", "io-upsum", null, host);
      H("b", null, num(u.total) + " event" + (num(u.total) === 1 ? "" : "s"), sm);
      sm.appendChild(document.createTextNode(" in the next 30 days · " + num(u.tasks_open) + " open task(s)"));
      if (num(u.tasks_unassigned)) { sm.appendChild(document.createTextNode(" · ")); H("b", "neg", num(u.tasks_unassigned) + " not assigned to anyone", sm); }
      var mx = Math.max.apply(null, wk.map(function (w) { return num(w.events); }).concat([1])), ww = H("div", "io-weeks", null, host);
      var MONS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      var sd = function (x) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(x || "")); return m ? (+m[3]) + " " + MONS[+m[2] - 1] : String(x || ""); };
      wk.forEach(function (w, i) { bar(ww, i === 0 ? "Next 7 days" : sd(w.from) + " – " + sd(w.to), num(w.events), mx, "c-accent"); });
      var tb = table(host, [["Date"], ["Event"], ["Stage"], ["Guests", "n"], ["Open tasks", "n"], ["Unassigned", "n"], ["Crew", "n"]]);
      ev.forEach(function (e) { var tr = H("tr", null, null, tb);
        H("td", null, fmtDate(e.date), tr);
        var td = H("td", null, null, tr), a = H("a", null, e.code || "Event", td); a.href = href(e.id); if (e.title && e.title !== e.code) H("div", "io-sub", e.title, td);
        H("td", null, String(e.stage || "").replace(/_/g, " "), tr); H("td", "n", e.guests == null ? "—" : String(e.guests), tr);
        H("td", "n", num(e.tasks_open) + " / " + num(e.tasks), tr);
        H("td", "n" + (num(e.tasks_unassigned) ? " neg" : ""), String(num(e.tasks_unassigned)), tr);
        H("td", "n" + (!num(e.crew) ? " muted" : ""), String(num(e.crew)), tr); });
      if (num(u.total) > ev.length) H("p", "note", "Showing the first " + ev.length + " of " + num(u.total) + ".", host);
    }
    function renderPackages() {
      var host = hosts.packages; if (!host) return; host.textContent = "";
      var d = st.d, pk = d.packages || {}, list = packageRevenue(pk.list || [], st.rows);
      if (!list.length) { H("div", "empty io-empty", num(pk.without) ? "None of this period's " + num(pk.without) + " confirmed event(s) used a package." : "No confirmed events in this period.", host); return; }
      var fin = d.finance && st.rows, tb = table(host, fin ? [["Package"], ["Events", "n"], ["Revenue (ex-tax)", "n"]] : [["Package"], ["Events", "n"]]);
      list.forEach(function (x) { var tr = H("tr", null, null, tb); H("td", null, x.name, tr); H("td", "n", String(x.events), tr);
        if (fin) { var td = H("td", "n", null, tr); if (!x.money.length) td.textContent = "—";
          x.money.forEach(function (m, i) { if (i) td.appendChild(document.createTextNode(" · ")); money("span", null, m.revenue, m.currency, td); }); } });
      if (num(pk.without)) H("p", "note", num(pk.without) + " confirmed event(s) without a package.", host);
    }
    function renderCancels() {
      var host = hosts.cancels; if (!host) return; host.textContent = "";
      var d = st.d, c = (d.funnel && d.funnel.cur) || {}, p = (d.funnel && d.funnel.prev) || {};
      var top = H("div", "io-cx", null, host); H("b", null, num(c.cancellations) + " cancellation(s)", top);
      chip(top, delta(c.cancellations, p.cancellations, "count", true), String(num(p.cancellations)));
      var rs = d.cancellations && d.cancellations.reasons;
      if (!d.quotes) { H("p", "note", "Reasons need access to Quotes.", host); return; }
      if (!Array.isArray(rs) || !rs.length) { H("div", "muted", "No reasons recorded in this period.", host); return; }
      var mx = Math.max.apply(null, rs.map(function (r) { return num(r.count); }).concat([1]));
      rs.forEach(function (r) { bar(host, r.reason, num(r.count), mx, "c-warn"); });
    }
    function render() {
      if (st.msg) { [hosts.glance, hosts.funnel, hosts.upcoming, hosts.packages, hosts.cancels].forEach(function (h) { if (h) empty(h, st.msg); });
        if (hosts.payCard) hosts.payCard.hidden = true; return; }
      if (!st.d) return;
      renderGlance(); renderFunnel(); renderPayments(); renderUpcoming(); renderPackages(); renderCancels();
    }
    /* re-draw when the eye button hides / shows amounts */
    var lastHidden = hidden();
    try { new MutationObserver(function () { var h = hidden(); if (h !== lastHidden) { lastHidden = h; render(); } }).observe(document.documentElement, { attributes: true, attributeFilter: ["class"] }); } catch (e) {}
    return {
      set: function (d) { st.d = d || null; st.msg = ""; render(); },
      ledger: function (rows, note, cut) { st.rows = Array.isArray(rows) ? rows : null; st.ledgerNote = note || ""; st.ledgerCut = !!cut; render(); },
      clear: function (msg) { st.d = null; st.msg = msg || "Couldn’t load — try again."; render(); },
      data: function () { return st.d; },
      csv: function () { if (!st.d) return null; return toCSV(csvRows(st.d, st.d.finance ? st.rows : null, { sourceLabel: srcLabel })); }
    };
  }

  var API = { pct: pct, delta: delta, ledgerTotals: ledgerTotals, packageRevenue: packageRevenue, marginsFromLedger: marginsFromLedger,
    toCSV: toCSV, csvRows: csvRows, cell: cell, mount: mount, MASK: MASK };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  root.HelmInsightsOverview = API;
})(typeof window !== "undefined" ? window : globalThis);
