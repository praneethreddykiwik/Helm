/* vendor-flow.js - R259 (0447, owner: "they will hit available ... attach a PDF or picture and enter the total price and the products' price also"):
 * the studio's side of the one vendor flow, the same on Vendors, Resource plan, Inventory, Wrap-up and Budget.
 *
 *   HelmVendorFlow.ask(o)            "Ask vendor" dialog -> Promise(row | null). o: { quoteId, vendorId, bookingId, lines, date, time, where, details, lockVendor, returnFocus, onDone }
 *   HelmVendorFlow.linesEditor(o)    the product list (name, quantity, price each) -> { el, read(), set(lines), onchange }
 *   HelmVendorFlow.offerBox(row, o)  the vendor's answer: lines against what was asked, total, file, Approve price / Ask to change / Decline. o: { canAssign, reload }
 *   HelmVendorFlow.record(row, o)    the vendor told their answer by phone
 *   HelmVendorFlow.askInvoice(o)     "Please send your invoice": the words first, then send, or only a link. o: { requestId | bookingId, name, onDone }
 *   HelmVendorFlow.steps(row)        Asked - Available - Confirmed - Invoice asked - Invoice received - Approved - Paid - Closed, with where it is now (row.pay: R261)
 *   HelmVendorFlow.openFile(get, o)  opens a private file in a new tab (the tab is opened inside the click; blocked = a dialog with the link)
 *   HelmVendorFlow.payBooking(o)     record a payment for a booked vendor without a bill (0450). o: { bookingId, name, due, currency, onDone }
 *   HelmVendorFlow.closeNoPay(o)     close a vendor without a payment, with the reason. o: { bookingId, name, onDone }
 *   HelmVendorFlow.budget(host, id)  the event budget's "Vendors" card
 *   HelmVendorFlow._pure             the helpers without a page (unit-tested)
 *
 * Every price and right is checked again in the database. A row without prices (no right to see money) shows no amount. Nothing is sent before a
 * button that says so is pressed. DOM calls only (textContent), no HTML strings, no inline styles. */
(function (global) {
  "use strict";
  var doc = global.document, CSS_V = "/vendor-flow.css?v=2";
  var STEPS = ["Asked", "Available", "Confirmed", "Invoice asked", "Invoice received", "Approved", "Paid", "Closed"];

  /* ---------------------------------------------------------------- pure */
  function r2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  // "1,250.50" -> 1250.5; "" -> null; anything else NaN (0 or more, at most 2 decimals)
  function amount(v) { var t = String(v == null ? "" : v).replace(/[\s,]/g, ""); if (t === "") return null; return /^\d{1,12}(\.\d{0,2})?$/.test(t) ? Number(t) : NaN; }
  function qn(n) { return num(n).toLocaleString("en-IN", { maximumFractionDigits: 2 }); }
  function isFlow(row) { return !!(row && Number(row.flow) === 447); }
  // the state of a row (an older server: from its status and invoice counts)
  function stateOf(r) {
    if (!r) return "none";
    // R261: what is really paid on the booking (bills + payouts + advance), when the page knows it: { k: paid | closed | unrecorded | owed | none }
    if (r.status === "accepted" && r.pay) { if (r.pay.k === "paid" && !num(r.invoices_open) && !num(r.invoices_queried)) return "paid"; if (r.pay.k === "closed" && !num(r.invoices_open)) return "closed_nopay"; if (r.pay.k === "unrecorded" && !num(r.invoices_open)) return "unrecorded"; }
    if (r.state) return r.state;
    if (r.status === "cancelled" || r.status === "reassigned") return "closed"; if (r.status === "rejected") return "declined"; if (r.status === "sent") return "asked";
    if (num(r.invoices_open)) return "invoice_received"; if (num(r.invoices_queried)) return "invoice_query";
    var ap = (r.invoices || []).filter(function (i) { return i.status === "approved"; });
    if (num(r.invoices_approved)) return ap.length && ap.every(function (i) { return i.pay_status === "paid"; }) ? "paid" : "invoice_approved";
    return "confirmed";
  }
  var INFO = { asked: [0, "Asked - waiting for their answer", "warn"], available: [1, "Available - approve their price", "warn"], change: [1, "Change asked - waiting for a new offer", "warn"], declined: [-1, "Not available", "off"], closed: [-1, "Closed", "off"],
    confirmed: [2, "Confirmed", ""], invoice_asked: [3, "Invoice asked", "warn"], invoice_received: [4, "Invoice received - to review", "warn"], invoice_query: [4, "Question sent about the invoice", "warn"], invoice_approved: [5, "Invoice approved", ""], paid: [7, "Paid and closed", ""], closed_nopay: [-1, "Closed without payment", "off"], unrecorded: [6, "Marked settled - no payment recorded", "warn"], none: [-1, "Not asked", "off"] };
  function info(r) { var k = stateOf(r), i = INFO[k] || INFO.none, t = i[1]; if (k === "declined" && r && r.declined_by === "studio") t = "You declined their offer"; return { k: k, step: i[0], text: t, tone: i[2] }; }
  function total(lines) { var all = lines.length > 0 && lines.every(function (l) { return l.price != null; }); return all ? r2(lines.reduce(function (a, l) { return a + r2(l.qty * l.price); }, 0)) : null; }
  function clean(t) { return String(t == null ? "" : t).replace(/\s+/g, " ").trim(); }
  // what the form holds -> { lines } | { error, at, field }
  function checkLines(rows) {
    if (!rows.length) return { error: "Add a product." };
    if (rows.length > 30) return { error: "Up to 30 products in one request." };
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var n = clean(rows[i].name), q = amount(rows[i].qty), p = amount(rows[i].price);
      if (!n || n.length > 120 || /[<>]/.test(n)) return { error: "Say what is needed (no < or >).", at: i, field: "name" };
      if (!(q > 0)) return { error: "Enter how many of " + n + ".", at: i, field: "qty" };
      if (p !== null && isNaN(p)) return { error: "Enter the price of " + n + " as a number, or leave it empty.", at: i, field: "price" };
      var l = { name: n, qty: q, price: p }; if (rows[i].unit) l.unit = clean(rows[i].unit).slice(0, 20); if (rows[i].need_id) l.need_id = rows[i].need_id; out.push(l);
    }
    return { lines: out };
  }
  // the offer against what was asked: [{ name, asked, qty, askedPrice, price, total, diff }]
  function compare(o) {
    return ((o && o.lines) || []).map(function (l) {
      var aq = num(l.asked_qty), q = num(l.qty), ap = l.asked_price == null ? null : num(l.asked_price), p = l.price == null ? null : num(l.price);
      return { name: l.name, unit: l.unit || "", asked: aq, qty: q, askedPrice: ap, price: p, total: l.total == null ? (p != null ? r2(p * q) : null) : num(l.total), lessQty: q < aq, otherPrice: ap != null && p != null && ap !== p };
    });
  }
  function zoned(d, t, tz) {   // a date + time on the studio's clock -> ISO
    var m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(d || ""), h = /^(\d\d):(\d\d)/.exec(t || ""); if (!m || !h) return null;
    var want = Date.UTC(+m[1], +m[2] - 1, +m[3], +h[1], +h[2]), at = want;
    try {
      for (var k = 0; k < 2; k++) {
        var p = {}; new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(new Date(at)).forEach(function (x) { p[x.type] = Number(x.value); });
        at += want - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
      }
      return new Date(at).toISOString();
    } catch (e) { return new Date(d + "T" + t).toISOString(); }
  }
  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function plainDay(s) { var m = /^(\d\d)\/(\d\d)\/(\d{4})$/.exec(s || ""); return m ? Number(m[1]) + " " + MON[Number(m[2]) - 1] + " " + m[3] : ""; }
  function mailMoney(n, cur) {   // the e-mail's own words (comms-dispatch billMoney)
    var v = Number(n), c = /^[A-Z]{3}$/.test(String(cur || "")) ? cur : "INR", w = Math.abs(v - Math.round(v)) < 0.005;
    return (c === "INR" ? "Rs " : c + " ") + v.toLocaleString(c === "INR" ? "en-IN" : "en-US", { minimumFractionDigits: w ? 0 : 2, maximumFractionDigits: w ? 0 : 2 });
  }
  // the exact words of the "please send your invoice" e-mail ({link} = their private link); the same as comms-dispatch vendorFlowMessage
  function askMail(p) {
    var c = p.confirmed || {}, cur = p.currency || "INR", ls = (c.lines || []).filter(function (l) { return num(l.qty) > 0; }), ev = (p.event || "the event") + (plainDay(p.event_date) ? " on " + plainDay(p.event_date) : "");
    var list = (ls.length ? ls.map(function (l) { return "- " + l.name + ": " + qn(l.qty) + (l.unit ? " " + l.unit : "") + (l.price != null ? " x " + mailMoney(l.price, cur) + " = " + mailMoney(r2(l.qty * l.price), cur) : ""); }).join("\n") : "- " + (p.what || "")) +
      (num(c.charges) > 0 ? "\nDelivery / other charges: " + mailMoney(c.charges, cur) : "") + (num(c.discount) > 0 ? "\nDiscount: " + mailMoney(c.discount, cur) : "") + (c.total != null && num(c.total) > 0 ? "\nAgreed total: " + mailMoney(c.total, cur) : "");
    return { subject: "Please send your invoice: " + ev + " - " + p.studio,
      text: "Hello" + (p.vendor_name ? " " + p.vendor_name : "") + ",\n\nThank you for your work at " + ev + ". Please send your invoice to " + p.studio + ".\n\n" + list +
        "\n\nOpen the link: your products and prices are already filled in. Add the invoice number and attach the invoice (PDF or photo). No sign-in.\n{link}\n\nAlready sent it? Then you can ignore this e-mail.\n\nThank you,\n" + p.studio };
  }
  var WHY = { no_email: "This vendor has no e-mail saved. Share the link instead.", trial_no_send: "Free trial: nothing is sent. Share the link after you upgrade.", sample_event: "This is a sample event: nothing is sent.", recent: "The e-mail was already asked for a moment ago. It is not sent twice.", already: "This e-mail was already asked for.", email_off: "E-mail is switched off for this studio." };
  function why(k) { return WHY[k] || "The e-mail can't be sent right now. Share the link instead."; }
  var pure = { amount: amount, stateOf: stateOf, info: info, total: total, checkLines: checkLines, compare: compare, zoned: zoned, askMail: askMail, mailMoney: mailMoney, isFlow: isFlow, STEPS: STEPS, why: why };
  var api = { _pure: pure, money: function (n, c) { return money(n, c); }, STEPS: STEPS, info: info, stateOf: stateOf };
  global.HelmVendorFlow = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (!doc || !doc.createElement) return;

  /* ---------------------------------------------------------------- DOM helpers */
  function S() { return global.BPStore; } function U() { return global.BPUI; }
  function h(tag, at, kids) {
    var e = doc.createElement(tag); at = at || {};
    Object.keys(at).forEach(function (k) { var v = at[k]; if (v == null || v === false) return; if (k === "text") e.textContent = String(v); else if (k === "cls") e.className = v; else if (k === "on") Object.keys(v).forEach(function (n) { e.addEventListener(n, v[n]); }); else e.setAttribute(k, v === true ? "" : String(v)); });
    (kids || []).forEach(function (c) { if (c == null || c === false) return; e.appendChild(typeof c === "string" ? doc.createTextNode(c) : c); });
    return e;
  }
  function clear(e) { while (e && e.firstChild) e.removeChild(e.firstChild); }
  function btn(t, fn, cls, label) { return h("button", { type: "button", cls: "hvf-btn" + (cls ? " " + cls : ""), text: t, "aria-label": label || null, on: { click: fn } }); }
  function toast(m, t) { try { U().toast(m, { type: t || "ok" }); } catch (e) {} }
  function friendly(e, a) { if (e && e.userText) return e.userText; if (e && /^(r447_|vendor_)/.test(String(e.hint || "")) && e.message) return up(e.message); try { return U().friendlyError(e, { action: a }); } catch (x) { return (e && e.message) || "Something went wrong."; } }
  function up(t) { t = String(t || ""); return t.charAt(0).toUpperCase() + t.slice(1); }
  function money(n, cur) { var B = S(), v = num(n);
    try { if ((cur || B.studioCurrency()) === "INR" && Math.round(v * 100) % 100) return "₹" + v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); } catch (e) {} try { if (B && B.moneyIn) return B.moneyIn(num(n), cur || (B.studioCurrency && B.studioCurrency())); } catch (e) {} return (cur || "") + " " + num(n).toLocaleString("en-IN"); }
  function symbol(cur) { var c = cur; try { c = c || S().studioCurrency(); } catch (e) {} c = c || "INR"; if (c === "INR") return "₹"; try { var p = new Intl.NumberFormat("en", { style: "currency", currency: c, currencyDisplay: "narrowSymbol" }).formatToParts(0).filter(function (x) { return x.type === "currency"; })[0]; return p ? p.value : c; } catch (e) { return c; } }
  function tz() { try { return S().studioTimezone() || "Asia/Kolkata"; } catch (e) { return "Asia/Kolkata"; } }
  function uuid() { try { if (global.crypto.randomUUID) return global.crypto.randomUUID(); } catch (e) {} var x = "0123456789abcdef", s = ""; for (var i = 0; i < 36; i++) s += i === 8 || i === 13 || i === 18 || i === 23 ? "-" : i === 14 ? "4" : x[Math.floor(Math.random() * 16)]; return s; }
  function css() { if (doc.querySelector('link[href*="vendor-flow.css"]')) return; doc.head.appendChild(h("link", { rel: "stylesheet", href: CSS_V })); }
  css();
  var uid = 0;
  function fld(label, input, full) { input.id = input.id || "hvf" + (++uid); return h("div", { cls: "hvf-f" + (full ? " hvf-full" : "") }, [h("label", { "for": input.id, text: label }), input]); }
  function inp(at) { return h("input", Object.assign({ cls: "hvf-in", autocomplete: "off" }, at || {})); }
  // a dialog: Escape / backdrop close it (asks nothing: the caller decides), focus stays inside and goes back where it was
  function dialog(title, opt) {
    opt = opt || {};
    var prev = opt.returnFocus || doc.activeElement, id = "hvfH" + (++uid), body = h("div", { cls: "hvf-body" }), foot = h("div", { cls: "hvf-foot" }), x = h("button", { type: "button", cls: "hvf-x", "aria-label": "Close", text: "×" }), box = { closed: false };
    var wrap = h("div", { cls: "hvf", role: "dialog", "aria-modal": "true", "aria-labelledby": id }, [h("div", { cls: "hvf-sheet" }, [h("div", { cls: "hvf-head" }, [h("h2", { cls: "hvf-h", id: id, text: title }), x]), body, foot])]);
    function key(e) {
      if (e.key === "Escape") { e.stopPropagation(); box.close(null); return; }
      if (e.key !== "Tab") return;
      var f = Array.prototype.filter.call(wrap.querySelectorAll("a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)"), function (n) { return n.offsetParent !== null; }); if (!f.length) return;
      if (e.shiftKey && doc.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); } else if (!e.shiftKey && doc.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    }
    box.close = function (v) { if (box.closed || box.busy) return; box.closed = true; doc.removeEventListener("keydown", key, true); if (wrap.parentNode) wrap.parentNode.removeChild(wrap); try { if (prev && prev.focus && prev.isConnected) prev.focus(); } catch (e) {} if (box.onclose) box.onclose(v); };
    x.addEventListener("click", function () { box.close(null); });
    wrap.addEventListener("mousedown", function (e) { if (e.target === wrap) box.close(null); });
    doc.addEventListener("keydown", key, true); doc.body.appendChild(wrap);
    box.body = body; box.foot = foot; box.wrap = wrap; box.err = h("p", { cls: "hvf-err", role: "alert", hidden: true });
    box.fail = function (m, f) { box.err.textContent = m; box.err.hidden = false; try { if (f) f.focus(); else box.err.scrollIntoView({ block: "nearest" }); } catch (e) {} };
    box.ok = function () { box.err.hidden = true; };
    box.run = function (b, label, fn) { if (box.busy) return; box.busy = true; box.ok(); var was = b.textContent; b.disabled = true; b.textContent = label; b.setAttribute("aria-busy", "true");
      var end = function () { box.busy = false; b.disabled = false; b.textContent = was; b.removeAttribute("aria-busy"); };
      return Promise.resolve().then(fn).then(function (v) { end(); return v; }, function (e) { end(); box.fail(friendly(e, "do this")); return undefined; }); };
    setTimeout(function () { if (!box.closed && !wrap.contains(doc.activeElement)) try { (wrap.querySelector(".hvf-body input:not([type=checkbox]),.hvf-body select,.hvf-body textarea") || x).focus(); } catch (e) {} }, 40);
    return box;
  }
  function copy(u) { try { global.navigator.clipboard.writeText(u).then(function () { toast("Link copied. Nothing was sent by itself."); }, function () { toast("Select the link and copy it.", "info"); }); } catch (e) { toast("Select the link and copy it.", "info"); } }
  function waLink(phone, text) { return "https://wa.me/" + String(phone || "").replace(/\D/g, "") + "?text=" + encodeURIComponent(text); }
  // the link once: copy it or open it in WhatsApp
  function share(row, o) {
    o = o || {}; var url = row && row.link && row.link.token ? S().vendorRequests.linkUrl(row.link.token) : "";
    if (!url) return null;
    var d = dialog(o.title || "Link for " + row.vendor_name, o), i = inp({ cls: "hvf-in hvf-link", value: url, readonly: true, "aria-label": "Link for " + row.vendor_name, on: { focus: function (e) { e.target.select(); } } });
    if (o.text) d.body.appendChild(h("p", { text: o.text }));
    d.body.appendChild(i); d.body.appendChild(h("p", { cls: "hvf-note", text: "Only for " + row.vendor_name + ". It opens this one request, without signing in." }));
    d.foot.appendChild(h("a", { cls: "hvf-btn", href: waLink(row.contact_phone, o.wa || ("Hello " + row.vendor_name + ", please answer our request here: ") + url), target: "_blank", rel: "noopener noreferrer", text: "Open in WhatsApp" }));
    d.foot.appendChild(btn("Copy link", function () { copy(url); }, "is-main"));
    return d;
  }
  function waRequest(row, url) { return "Hello " + row.vendor_name + ", are you available for " + row.what + (num(row.qty) > 0 ? " x" + qn(row.qty) : "") + " on " + String(row.when_text || "") + "? Please answer and tell us your price here (no sign-in): " + url; }

  /* ---------------------------------------------------------------- the product list */
  api.linesEditor = function (o) {
    o = o || {}; var cur = o.currency, box = h("div", { cls: "hvf-ed" }), list = h("div", { cls: "hvf-ed" }), tot = h("p", { cls: "hvf-tot", hidden: true }), chips = h("div", { cls: "hvf-add" }), rows = [], E = { el: box, onchange: null, max: 30 };
    var pl = "Price each (" + symbol(cur) + ")";
    box.appendChild(h("div", { cls: "hvf-row is-head", "aria-hidden": "true" }, [h("span", { text: "Product" }), h("span", { text: "Quantity" }), h("span", { text: pl }), h("span", { cls: "hvf-t", text: "Total" }), h("span")]));
    box.appendChild(list); box.appendChild(chips); box.appendChild(tot);
    function lab(t, i, c) { return h("label", { cls: "hvf-c" + (c || "") }, [h("span", { cls: "hvf-cl", text: t }), i]); }
    function sum() {
      var ls = rows.map(function (r) { return { qty: amount(r.q.value), price: amount(r.p.value) }; });
      rows.forEach(function (r, i) { var l = ls[i]; r.t.textContent = l.qty > 0 && l.price != null && !isNaN(l.price) ? money(r2(l.qty * l.price), cur) : ""; if (r.t.textContent) r.t.setAttribute("data-money", ""); else r.t.removeAttribute("data-money"); r.x.disabled = rows.length < 2; });
      var ok = ls.every(function (l) { return l.qty > 0 && !isNaN(l.price); }), t = ok ? total(ls) : null;
      tot.hidden = t == null; clear(tot); if (t != null) { tot.appendChild(h("span", { text: "Agreed total" })); tot.appendChild(h("b", { text: money(t, cur), "data-money": "" })); }
      E.total = t; drawChips(); if (E.onchange) E.onchange(t);
    }
    function add(l, focus) {
      if (rows.length >= 30) return; l = l || {}; var n = ++uid, r = { need_id: l.need_id || null, unit: l.unit || null };
      r.n = inp({ maxlength: "120", value: l.name || "", placeholder: "e.g. Chairs", "aria-label": "Product" }); r.q = inp({ inputmode: "decimal", maxlength: "10", value: l.qty != null ? l.qty : "1", "aria-label": "Quantity" }); r.p = inp({ inputmode: "decimal", maxlength: "13", value: l.price != null ? l.price : "", placeholder: "Optional", "aria-label": pl, "data-money": "" });
      r.t = h("span", { cls: "hvf-t" }); r.x = h("button", { type: "button", cls: "hvf-rm", "aria-label": "Remove this product", text: "×" });
      r.el = h("div", { cls: "hvf-row", role: "group", "aria-label": "Product " + n }, [lab("Product", r.n, " hvf-c-name"), lab("Quantity", r.q), lab(pl, r.p), r.t, r.x]);
      [r.n, r.q, r.p].forEach(function (i) { i.addEventListener("input", sum); });
      r.x.addEventListener("click", function () { if (rows.length < 2) return; rows.splice(rows.indexOf(r), 1); list.removeChild(r.el); sum(); if (rows.length) rows[rows.length - 1].n.focus(); });
      rows.push(r); list.appendChild(r.el); if (focus) r.n.focus(); sum();
    }
    function drawChips() {
      clear(chips); chips.appendChild(h("button", { type: "button", cls: "hvf-chip", text: "＋ Add a product", disabled: rows.length >= 30, on: { click: function () { add(null, true); } } }));
      (o.suggest || []).forEach(function (s) { if (rows.some(function (r) { return r.need_id === s.need_id; }) || rows.length >= 30) return; chips.appendChild(h("button", { type: "button", cls: "hvf-chip", text: "＋ " + s.name + " (" + qn(s.qty) + ")", on: { click: function () { add(s); } } })); });
    }
    E.set = function (ls) { clear(list); rows = []; (ls && ls.length ? ls : [{}]).slice(0, 30).forEach(function (l) { add(l); }); };
    E.suggest = function (s) { o.suggest = s || []; drawChips(); };
    E.read = function () { var v = checkLines(rows.map(function (r) { return { name: r.n.value, qty: r.q.value, price: r.p.value, unit: r.unit, need_id: r.need_id }; })); if (v.error && v.at != null) v.el = rows[v.at][v.field === "name" ? "n" : v.field === "qty" ? "q" : "p"]; return v; };
    E.set(o.lines); return E;
  };

  /* ---------------------------------------------------------------- ask */
  var VEND = null;
  function vendors() { if (VEND && Date.now() - VEND.at < 60000) return Promise.resolve(VEND.v); return Promise.resolve(S().vendors.listAll(false)).then(function (v) { VEND = { at: Date.now(), v: (v || []).filter(function (x) { return x && x.active !== false; }) }; return VEND.v; }); }
  function sn(n) { try { return S().sampleName ? S().sampleName(n) : n; } catch (e) { return n; } }
  api.ask = function (o) {
    o = o || {}; var key = uuid(), sig = "";
    return new Promise(function (done) {
      var d = dialog(o.title || "Ask a vendor", o); d.onclose = function (v) { done(v || null); if (o.onDone) o.onDone(v || null); };
      d.body.appendChild(h("p", { cls: "hvf-note", role: "status", text: "Loading…" }));
      var ev = !o.quoteId && S().quotes && S().quotes.list ? Promise.resolve(S().quotes.list()).then(function (l) { return (l || []).filter(function (q) { var s = String(q.status || "").toLowerCase(); return q.id && s !== "lost" && s !== "cancelled"; }).slice(0, 200); }) : Promise.resolve(null);
      var one = o.quoteId && !o.date && S().quotes && S().quotes.get ? Promise.resolve(S().quotes.get(o.quoteId)).catch(function () { return null; }) : Promise.resolve(null);
      Promise.all([vendors(), ev, one]).then(function (res) {
        if (d.closed) return; var list = res[0], evs = res[1], q1 = res[2]; clear(d.body);
        if (!list.length) { d.body.appendChild(h("p", { text: "Add the vendor under Vendors first." })); d.foot.appendChild(h("a", { cls: "hvf-btn is-main", href: "vendors.html", text: "Open Vendors" })); return; }
        var cur = null; try { cur = q1 && S().quoteCurrency ? S().quoteCurrency(q1) : S().studioCurrency(); } catch (e) {}
        var es = evs ? h("select", { cls: "hvf-in" }, [h("option", { value: "", text: "Choose the event…" })].concat(evs.map(function (q) { return h("option", { value: q.id, text: (q.code || "") + " · " + (q.title || "Event") + (q.eventDate ? " · " + String(q.eventDate).slice(0, 10).split("-").reverse().join("/") : "") }); }))) : null;
        var vs = h("select", { cls: "hvf-in" }, [h("option", { value: "", text: "Choose a vendor…" })].concat(list.map(function (v) { return h("option", { value: v.id, text: sn(v.name) + (v.category ? " · " + v.category : "") + (v.email ? "" : " (no e-mail - share the link)") }); })));
        if (o.vendorId) { vs.value = o.vendorId; vs.disabled = !!o.lockVendor && vs.value === o.vendorId; }
        var ed = api.linesEditor({ lines: o.lines, currency: cur, suggest: o.suggest });
        var day = inp({ type: "date", value: o.date || (q1 && q1.eventDate ? String(q1.eventDate).slice(0, 10) : "") }), tm = inp({ type: "time", value: o.time || "10:00" }), rb = inp({ type: "date" });
        var wh = inp({ maxlength: "300", placeholder: "e.g. Lawn gate 2", value: o.where || (q1 && q1.client && q1.client.venue ? String(q1.client.venue).slice(0, 300) : "") }), det = h("textarea", { cls: "hvf-in", maxlength: "1000", rows: "2", placeholder: "Anything they must know" }); det.value = o.details || "";
        var at = inp({ inputmode: "decimal", maxlength: "15", placeholder: "Leave empty: the vendor tells you", "data-money": "" }), atF = fld("Agreed total (" + symbol(cur) + ", optional)", at);
        var mail = h("input", { type: "checkbox", checked: true }); mail.checked = true;
        ed.onchange = function (t) { atF.hidden = t != null; }; ed.onchange(ed.total);
        d.body.appendChild(h("div", { cls: "hvf-g" }, [es ? fld("Event *", es, true) : null, fld("Vendor *", vs, true)]));
        d.body.appendChild(h("p", { cls: "hvf-lbl", text: "What you need *" })); d.body.appendChild(ed.el);
        d.body.appendChild(h("p", { cls: "hvf-note", text: "Know the price? Enter it, and the vendor only has to say yes. Leave it empty and the vendor tells you." }));
        d.body.appendChild(h("div", { cls: "hvf-g" }, [atF, fld("Needed on *", day), fld("Time *", tm), fld("Reply by (optional)", rb), fld("Where", wh, true), fld("Details", det, true)]));
        d.body.appendChild(h("label", { cls: "hvf-chk" }, [mail, h("span", { text: "E-mail the request (when studio e-mail is on)" })]));
        d.body.appendChild(d.err);
        var go = btn("Send request", function () {
          var eid = o.quoteId || (es && es.value); if (!eid) return d.fail("Choose the event.", es);
          if (!vs.value) return d.fail("Choose the vendor.", vs);
          var v = ed.read(); if (v.error) return d.fail(v.error, v.el);
          var iso = zoned(day.value, tm.value, tz()); if (!iso) return d.fail("Pick the date and time.", day.value ? tm : day);
          var a = amount(at.value); if (!atF.hidden && a !== null && isNaN(a)) return d.fail("Enter the agreed total as a number, or leave it empty.", at);
          if (/[<>]/.test(wh.value + det.value)) return d.fail("Where and details may not contain < or >.", wh);
          var p = { quote_id: eid, vendor_id: vs.value, booking_id: o.bookingId || null, lines: v.lines, when_at: iso, where_text: clean(wh.value) || null, details: det.value.trim() || null, send: mail.checked };
          if (!atF.hidden && a !== null) p.agreed_total = a;
          if (rb.value) p.respond_by = zoned(rb.value, "20:00", tz());
          var sg = JSON.stringify(p); if (sg !== sig) { sig = sg; key = uuid(); } p.key = key;
          d.run(go, "Sending…", function () { return S().vendorRequests.ask(p); }).then(function (row) {
            if (!row) return; row.sent_lines = v.lines; toast("Request sent to " + row.vendor_name + ".");
            d.close(row); sent(row);
          });
        }, "is-main");
        d.foot.appendChild(btn("Cancel", function () { d.close(null); })); d.foot.appendChild(go);
        try { (es || (o.lockVendor && vs.value ? day : vs)).focus(); } catch (e) {}
      }).catch(function (e) { if (d.closed) return; clear(d.body); d.body.appendChild(h("p", { cls: "hvf-err", role: "alert", text: friendly(e, "load the vendors") })); });
    });
  };
  function sent(row) {
    if (row.link && row.link.token) { var u = S().vendorRequests.linkUrl(row.link.token); share(row, { title: "Request sent", text: row.contact_email ? "The e-mail to " + row.contact_email + " is on its way (when studio e-mail is on). You can also share the link yourself:" : row.vendor_name + " has no e-mail saved. Send them this link:", wa: waRequest(row, u) }); }
    else if (row && row.id && global.HelmTrialPreview) global.HelmTrialPreview.open("vendor", { quoteId: row.quote_id, requestId: row.id });   // R125: a trial has no link - the preview instead
  }
  api.sent = sent; api.share = share; api.waRequest = waRequest;

  /* ---------------------------------------------------------------- the offer */
  function table(head, rows, sums) {
    return h("table", { cls: "hvf-tbl", "data-tm": "off" }, [h("thead", {}, [h("tr", {}, head.map(function (t) { return h("th", { scope: "col", text: t }); }))]),
      h("tbody", {}, rows.map(function (r) { return h("tr", {}, r.map(cell)); })
        .concat((sums || []).map(function (s) { return h("tr", { cls: "is-sum" }, [h("td", { text: s[0] })].concat(head.slice(2).map(function () { return h("td"); })).concat([cell({ t: s[1], m: 1 })])); })))]);
  }
  // { t, m: an amount (the "amounts hidden" switch covers only these), diff }
  function cell(c) { var o = c && typeof c === "object" ? c : { t: c }; return h("td", { cls: o.diff ? "is-diff" : null, "data-money": o.m && o.t ? "" : null }, [o.t == null ? "" : String(o.t), o.sub ? h("small", { text: o.sub }) : null]); }
  function offerTable(o, cur) {
    var c = compare(o), m = o.total != null;
    var head = m ? (o.mode === "total" ? ["Product", "Quantity", "Total"] : ["Product", "Quantity", "Price each", "Total"]) : ["Product", "Quantity"];
    var rows = c.map(function (l) {
      var q = { t: qn(l.qty) + (l.unit ? " " + l.unit : "") + (l.lessQty ? " of " + qn(l.asked) : ""), diff: l.lessQty };
      if (!m) return [l.name, q]; if (o.mode === "total") return [l.name, q, ""];
      return [l.name, q, { t: l.price == null ? "" : money(l.price, cur), sub: l.otherPrice ? "asked " + money(l.askedPrice, cur) : "", diff: l.otherPrice, m: 1 }, { t: l.total == null ? "" : money(l.total, cur), m: 1 }];
    });
    var sums = []; if (m) { if (num(o.charges) > 0) sums.push(["Delivery / other charges", money(o.charges, cur)]); if (num(o.discount) > 0) sums.push(["Discount", "- " + money(o.discount, cur)]); sums.push(["Total", money(o.total, cur)]); }
    return table(head, rows, sums);
  }
  api.invoiceLines = function (i, cur) {
    if (!i || !Array.isArray(i.lines) || !i.lines.length) return null; var sums = [];
    if (num(i.charges) > 0) sums.push(["Delivery / other charges", money(i.charges, cur)]); if (num(i.discount) > 0) sums.push(["Discount", "- " + money(i.discount, cur)]);
    if (num(i.tax_amount) > 0) sums.push(["Tax", money(i.tax_amount, cur)]);
    return table(["Product", "Quantity", "Price each", "Total"], i.lines.map(function (l) { return [l.name, qn(l.qty) + (l.unit ? " " + l.unit : ""), { t: money(l.price, cur), m: 1 }, { t: money(l.total, cur), m: 1 }]; }), sums);
  };
  // R261 (owner: "open their file is not working"): the browser blocks a tab that is opened after the link has been fetched. The empty tab is opened inside
  // the click (its opener cut), then sent to the link; a browser that blocks even that gets a dialog with the link.
  api.openFile = function (get, o) {
    o = o || {}; var w = null, name = o.name || "the file";
    try { w = global.open("about:blank", "_blank"); } catch (e) { w = null; }
    if (w) try { w.opener = null; w.document.title = "Opening…"; w.document.body.textContent = "Opening the file…"; } catch (e) { /* ignore */ }
    var shut = function () { if (w) try { w.close(); } catch (e) { /* ignore */ } };
    return Promise.resolve().then(get).then(function (u) {
      if (!u || !/^https?:\/\//.test(String(u))) throw new Error("The file is not available.");
      if (w && !w.closed) { try { w.location.replace(u); return "tab"; } catch (e) { shut(); } }
      var d = dialog("Open " + name, o), dl = u + (u.indexOf("?") >= 0 ? "&" : "?") + "download=";
      d.body.appendChild(h("p", { text: "Your browser blocked the new tab. Open the file from here." })); d.body.appendChild(h("p", { cls: "hvf-note", text: "The link works for about 2 minutes." }));
      d.foot.appendChild(h("a", { cls: "hvf-btn", href: dl, rel: "noopener noreferrer", text: "Download" }));
      var a = h("a", { cls: "hvf-btn is-main", href: u, target: "_blank", rel: "noopener noreferrer", text: "Open the file" }); d.foot.appendChild(a); setTimeout(function () { try { a.focus(); } catch (e) {} }, 60);
      return "dialog";
    }).catch(function (e) { shut(); toast(friendly(e, "open the file"), "err"); return "error"; });
  };
  function openFile(path, name, from) { return api.openFile(function () { return S().vendorRequests.fileUrl(path); }, { name: name, returnFocus: from }); }
  var STATUS = { offered: "Waiting for you", change_asked: "Change asked", approved: "Approved", declined: "Declined", superseded: "Replaced by a newer answer", withdrawn: "Taken back" };
  api.offerBox = function (row, o) {
    o = o || {}; var f = row && row.offer; if (!f) return null;
    var open = row.offer_open === true, cur = row.currency, box = h("section", { cls: "hvf-box" + (open ? " is-open" : ""), "aria-label": "Offer from " + row.vendor_name });
    box.appendChild(h("div", { cls: "hvf-box-h" }, [h("span", { text: open ? "Available - their offer" : "Their offer: " + (STATUS[f.status] || f.status) }), f.total != null ? h("b", { text: money(f.total, cur), "data-money": "" }) : null]));
    var ag = row.asked_amount != null ? row.asked_amount : open && !row.price_open ? row.agreed_amount : null;
    if (f.total != null && ag != null && Math.abs(f.total - ag) > 0.004) box.appendChild(h("p", { cls: "hvf-note", "data-money": "", text: money(Math.abs(f.total - ag), cur) + (f.total > ag ? " more" : " less") + " than the agreed " + money(ag, cur) }));
    box.appendChild(offerTable(f, cur));
    if (f.note) box.appendChild(h("p", { text: "“" + f.note + "”" }));
    if (f.review_note && f.status !== "approved") box.appendChild(h("p", { cls: "hvf-note", text: "You wrote: " + f.review_note }));
    box.appendChild(h("p", { cls: "hvf-note", text: (f.at_text || "") + (f.via === "studio" ? " (recorded by the studio)" : "") }));
    var acts = h("div", { cls: "hvf-acts" });
    if (f.has_file && f.storage_path) acts.appendChild(btn("Open their file", function (e) { openFile(f.storage_path, "the file of " + row.vendor_name, e && e.currentTarget); }));
    if (open && o.canAssign) {
      acts.appendChild(btn("Approve price", function (e) { approve(row, f, o, e.currentTarget); }, "is-main", "Approve the price of " + row.vendor_name));
      acts.appendChild(btn("Ask to change", function () { answer(row, f, o, "change"); }, "", "Ask " + row.vendor_name + " to change the offer"));
      acts.appendChild(btn("Decline", function () { answer(row, f, o, "decline"); }, "is-bad", "Decline the offer of " + row.vendor_name));
    }
    if (acts.firstChild) box.appendChild(acts);
    if (open && !o.canAssign) box.appendChild(h("p", { cls: "hvf-note", text: "Someone who can change Vendors approves the price." }));
    var old = (row.offers || []).filter(function (x) { return x.id !== f.id; });
    if (old.length && o.history !== false) box.appendChild(h("details", {}, [h("summary", { text: "Earlier answers (" + old.length + ")" })].concat(old.map(function (x) { return h("p", { cls: "hvf-note", text: (x.at_text || "") + (x.total != null ? " · " + money(x.total, cur) : "") + " · " + (STATUS[x.status] || x.status) + (x.review_note ? " · you wrote: " + x.review_note : "") }); }))));
    return box;
  };
  function after(o, msg) { return function (r) { if (!r) return; toast(msg + (r.mail && r.mail.queued ? " The vendor gets an e-mail." : "")); if (o.reload) o.reload(r); }; }
  function approve(row, f, o, from) {
    var d = dialog("Approve the price of " + row.vendor_name + "?", { returnFocus: from }), mail = h("input", { type: "checkbox" }); mail.checked = !!row.contact_email;
    d.body.appendChild(h("p", { text: "The booking is confirmed" + (f.total != null ? " at " + money(f.total, row.currency) : "") + ". It counts as committed cost for the event." }));
    d.body.appendChild(offerTable(f, row.currency));
    if (row.contact_email) d.body.appendChild(h("label", { cls: "hvf-chk" }, [mail, h("span", { text: "E-mail " + row.vendor_name + " that the booking is confirmed" })]));
    d.body.appendChild(d.err);
    var go = btn("Approve price", function () { d.run(go, "Approving…", function () { return S().vendorRequests.offerReview(f.id, "approve", null, mail.checked && !!row.contact_email); }).then(function (r) { if (!r) return; d.close(r); after(o, row.vendor_name + " is booked.")(r); }); }, "is-main");
    d.foot.appendChild(btn("Not yet", function () { d.close(null); })); d.foot.appendChild(go); go.focus();
  }
  function answer(row, f, o, act) {
    var ch = act === "change", d = dialog(ch ? "Ask " + row.vendor_name + " to change the offer" : "Decline the offer of " + row.vendor_name + "?"), t = h("textarea", { cls: "hvf-in", rows: "3", maxlength: "500" }), mail = h("input", { type: "checkbox" }); mail.checked = !!row.contact_email;
    d.body.appendChild(h("p", { text: ch ? "They see your message on their link and can send a new offer." : "The request is closed for this vendor and kept in the history. You can give it to another vendor (Reassign)." }));
    d.body.appendChild(fld(ch ? "Your message *" : "Why? (they see this) *", t));
    if (ch && row.contact_email) d.body.appendChild(h("label", { cls: "hvf-chk" }, [mail, h("span", { text: "E-mail it to them too" })]));
    d.body.appendChild(d.err);
    var go = btn(ch ? "Send message" : "Decline offer", function () {
      var v = clean(t.value); if (v.length < 3) return d.fail("Write a short message.", t); if (/[<>]/.test(v)) return d.fail("Leave out < and >.", t);
      d.run(go, "Sending…", function () { return S().vendorRequests.offerReview(f.id, act, v, ch && mail.checked && !!row.contact_email); }).then(function (r) { if (!r) return; d.close(r); after(o, ch ? "Message sent." : "Offer declined.")(r); });
    }, ch ? "is-main" : "is-bad");
    d.foot.appendChild(btn("Cancel", function () { d.close(null); })); d.foot.appendChild(go); t.focus();
  }
  // told by phone: the same numbers, typed by the studio
  api.record = function (row, o) {
    o = o || {}; var d = dialog("What did " + row.vendor_name + " answer?"), cur = row.currency, key = uuid(), rows = (row.lines || []).map(function (l) {
      var q = inp({ inputmode: "decimal", maxlength: "10", value: l.qty, "aria-label": "Quantity of " + l.name }), p = inp({ inputmode: "decimal", maxlength: "13", value: l.price != null ? l.price : "", "aria-label": "Price each of " + l.name, "data-money": "" });
      return { l: l, q: q, p: p, el: h("div", { cls: "hvf-g" }, [h("p", { cls: "hvf-lbl hvf-full", text: l.name + " (asked " + qn(l.qty) + ")" }), fld("Quantity", q), fld("Price each (" + symbol(cur) + ")", p)]) };
    });
    var tot = inp({ inputmode: "decimal", maxlength: "15", "data-money": "", placeholder: "Only when there is no price per product" }), note = inp({ maxlength: "500" });
    d.body.appendChild(h("p", { text: "Available: check the numbers and press Record. The booking is confirmed at this price." }));
    rows.forEach(function (r) { d.body.appendChild(r.el); });
    d.body.appendChild(h("div", { cls: "hvf-g" }, [fld("Or one total price (" + symbol(cur) + ")", tot, true), fld("Note (optional)", note, true)])); d.body.appendChild(d.err);
    var no = btn("Not available", function () {
      var v = clean(note.value); if (v.length < 3) return d.fail("Write in the note why they are not available.", note); if (/[<>]/.test(v)) return d.fail("Leave out < and >.", note);
      d.run(no, "Saving…", function () { return S().vendorRequests.setStatus(row.id, "rejected", v); }).then(function (r) { if (!r) return; d.close(r); after(o, "Recorded: not available.")(r); });
    }, "is-bad");
    var go = btn("Record: available", function () {
      var t = amount(tot.value), one = t !== null, bad = null, ls = rows.map(function (r) { var q = amount(r.q.value), p = amount(r.p.value); if (!bad && !(q >= 0)) bad = [r.q, "Enter the quantity of " + r.l.name + "."]; if (!bad && q > num(r.l.qty)) bad = [r.q, "Only " + qn(r.l.qty) + " of " + r.l.name + " are asked for."]; if (!bad && !one && q > 0 && (p === null || isNaN(p))) bad = [r.p, "Enter the price of " + r.l.name + ", or one total price."]; return { id: r.l.id, qty: q, price: one ? null : p == null ? 0 : p }; });
      if (!bad && one && isNaN(t)) bad = [tot, "Enter the total as a number."]; if (!bad && /[<>]/.test(note.value)) bad = [note, "Leave out < and >."]; if (bad) return d.fail(bad[1], bad[0]);
      var p = { available: true, approve: true, mode: one ? "total" : "lines", lines: ls, key: key }; if (one) p.total = t; if (clean(note.value)) p.note = clean(note.value);
      d.run(go, "Saving…", function () { return S().vendorRequests.recordOffer(row.id, p); }).then(function (r) { if (!r) return; d.close(r); after(o, "Recorded: " + row.vendor_name + " is booked.")(r); });
    }, "is-main");
    d.foot.appendChild(btn("Cancel", function () { d.close(null); })); d.foot.appendChild(no); d.foot.appendChild(go);
  };

  /* ---------------------------------------------------------------- please send your invoice */
  api.askInvoice = function (o) {
    o = o || {}; var key = uuid(), who = o.requestId ? { request_id: o.requestId } : { booking_id: o.bookingId };
    return new Promise(function (done) {
      var d = dialog("Ask " + (o.name || "the vendor") + " for the invoice", o); d.onclose = function (v) { done(v || null); if (o.onDone) o.onDone(v || null); };
      d.body.appendChild(h("p", { cls: "hvf-note", role: "status", text: "Loading…" }));
      S().vendorRequests.askInvoicePreview(who).then(function (p) {
        if (d.closed) return; clear(d.body);
        if (!p) {   // an older database: only the link of a confirmed request
          if (!o.requestId) { d.body.appendChild(h("p", { text: "This needs the latest database update. Ask them from the Resource plan." })); return; }
          return S().vendorRequests.issueLink(o.requestId).then(function (l) { d.close(null); share({ vendor_name: o.name || "the vendor", link: l }, { title: "Link for the invoice", text: "Nothing was sent. Share this link; they send their invoice there." }); });
        }
        if (p.last_asked) d.body.appendChild(h("p", { cls: "hvf-note", text: "Last asked: " + p.last_asked + "." }));
        var m = askMail(p);
        if (p.can_send) { d.body.appendChild(h("p", {}, ["To ", h("b", { text: p.to })])); d.body.appendChild(h("p", {}, [h("b", { text: m.subject })])); d.body.appendChild(h("div", { cls: "hvf-mail", "data-money": "", text: m.text.replace("{link}", "(their private link)") })); }
        else d.body.appendChild(h("p", { text: why(p.why) }));
        d.body.appendChild(d.err);
        var send = p.can_send ? btn("Send e-mail", function () { go(send, true); }, "is-main") : null, link = btn(p.can_send ? "Only make a link" : "Make a link", function () { go(link, false); }, p.can_send ? "" : "is-main");
        function go(b, mail) {
          d.run(b, mail ? "Sending…" : "Making the link…", function () { return S().vendorRequests.askInvoice(Object.assign({ send: mail, key: key }, who)); }).then(function (r) {
            if (!r) return; d.close(r);
            if (mail && r.mail && r.mail.queued) { toast("Asked " + r.vendor_name + " for the invoice."); return; }
            if (mail) toast(why(r.mail && r.mail.reason), "info");
            if (r.link && r.link.token) { var u = S().vendorRequests.linkUrl(r.link.token); share(r, { title: "Link for the invoice", text: "Nothing is sent by itself. They open it, no sign-in, and send their invoice there.", wa: "Hello " + r.vendor_name + ", please send us your invoice here (no sign-in): " + u }); }
            else if (global.HelmTrialPreview) global.HelmTrialPreview.open("vendor", { quoteId: r.quote_id, requestId: r.id });
          });
        }
        d.foot.appendChild(btn("Cancel", function () { d.close(null); })); d.foot.appendChild(link); if (send) d.foot.appendChild(send); (send || link).focus();
      }).catch(function (e) { if (d.closed) return; clear(d.body); d.body.appendChild(h("p", { cls: "hvf-err", role: "alert", text: friendly(e, "ask for the invoice") })); });
    });
  };

  /* ---------------------------------------------------------------- R261: paying a vendor who sent no bill, and closing without a payment */
  function today() { try { return S().todayLocal(); } catch (e) { return new Date().toISOString().slice(0, 10); } }
  api.payBooking = function (o) {
    o = o || {}; var key = "vbp-" + o.bookingId + "-" + uuid(), cur = o.currency;
    return new Promise(function (done) {
      var d = dialog("Record a payment to " + (o.name || "the vendor"), o); d.onclose = function (v) { done(v || null); if (o.onDone) o.onDone(v || null); };
      var amt = inp({ inputmode: "decimal", maxlength: "14", value: num(o.due) > 0 ? String(r2(o.due)) : "" }), day = inp({ type: "date", value: today(), max: today() }), how = h("select", { cls: "hvf-in" }, ["Bank transfer", "UPI", "Cash", "Cheque", "Card", "Other"].map(function (x) { return h("option", { value: x, text: x }); })), ref = inp({ maxlength: "120", placeholder: "UTR / cheque no. (optional)" });
      d.body.appendChild(h("p", { cls: "hvf-note", text: "No invoice from them yet: Helm makes the bill of the agreed price and records this payment on it." }));
      d.body.appendChild(h("div", { cls: "hvf-g" }, [fld("Amount paid (" + symbol(cur) + ")", amt), fld("Paid on", day), fld("How", how), fld("Reference", ref)]));
      if (num(o.due) > 0) d.body.appendChild(h("p", { cls: "hvf-note" }, ["Left to pay: ", h("b", { "data-money": "", text: money(o.due, cur) })]));
      d.body.appendChild(d.err);
      var go = btn("Record payment", function () {
        var a = amount(amt.value); if (!(a > 0)) return d.fail("Enter an amount above zero.", amt);
        if (num(o.due) > 0 && a > num(o.due) + 0.004) return d.fail("That is more than the " + money(o.due, cur) + " left to pay.", amt);
        if (!day.value || day.value > today()) return d.fail("Pick the day it was paid, today or before.", day);
        var MK = S().moneySafety && S().moneySafety.key, ks = "vbp:" + o.bookingId, k = key; if (MK) k = MK.get(ks, [a, day.value, how.value].join("|"));
        d.run(go, "Saving…", function () { return S().bookings.pay(o.bookingId, { amount: a, paidOn: day.value, method: how.value, reference: ref.value.trim() || null }, k); }).then(function (r) {
          if (!r) return; if (MK) MK.done(ks); var w = Array.isArray(r.warnings) ? r.warnings.map(function (x) { return x && x.text; }).filter(Boolean).join(" ") : "";
          toast((r.duplicate ? "Already recorded." : "Payment recorded.") + (w ? " " + w : "")); d.close(r); });
      }, "is-main");
      d.foot.appendChild(btn("Cancel", function () { d.close(null); })); d.foot.appendChild(go);
    });
  };
  api.closeNoPay = function (o) {
    o = o || {};
    return new Promise(function (done) {
      var d = dialog("Close " + (o.name || "the vendor") + " without payment?", o); d.onclose = function (v) { done(v || null); if (o.onDone) o.onDone(v || null); };
      var why2 = h("textarea", { cls: "hvf-in", rows: "3", maxlength: "300", placeholder: "e.g. They did it for free, or it was paid outside Helm" });
      d.body.appendChild(h("p", { text: "Nothing is recorded as paid. The vendor is closed and this reason stays visible. You can undo it." }));
      d.body.appendChild(fld("Why is nothing paid?", why2, true)); d.body.appendChild(d.err);
      var go = btn("Close without payment", function () {
        var t = clean(why2.value); if (t.length < 3) return d.fail("Say why, at least 3 characters.", why2); if (/[<>]/.test(t)) return d.fail("Leave out < and >.", why2);
        d.run(go, "Saving…", function () { return S().bookings.closeNoPay(o.bookingId, t); }).then(function (r) { if (!r) return; toast("Closed without payment."); d.close(true); });
      }, "is-main");
      d.foot.appendChild(btn("Cancel", function () { d.close(null); })); d.foot.appendChild(go);
    });
  };

  /* ---------------------------------------------------------------- where it stands */
  api.steps = function (row) {
    var i = info(row);
    if (i.step < 0) return h("ol", { cls: "hvf-steps" }, [h("li", { cls: "is-now is-off", text: i.text })]);
    return h("ol", { cls: "hvf-steps", "aria-label": "Where it stands: " + i.text }, STEPS.map(function (t, n) { return n < i.step ? h("li", { cls: "is-done", text: t }) : n === i.step ? h("li", { cls: "is-now" + (i.tone === "warn" ? " is-warn" : ""), "aria-current": "step", text: i.k === "change" ? "Change asked" : i.k === "invoice_query" ? "Question sent" : i.k === "unrecorded" ? "No payment recorded" : t + (n === 1 && row.offer && row.offer.total != null ? " (" + money(row.offer.total, row.currency) + ")" : "") }) : h("li", { text: t }); }));
  };
  // Budget: every vendor of the event, one line each (hidden without the right to see vendors, or with none)
  api.budget = function (host, quoteId) {
    if (!host || !S() || !S().vendorRequests || !quoteId) return Promise.resolve(false);
    return Promise.all([S().vendorRequests.list(quoteId, null), S().bookings && S().bookings.list ? Promise.resolve(S().bookings.list(quoteId)).catch(function () { return []; }) : []]).then(function (res) {
      var rs = (res[0] || []).filter(function (r) { return r.status !== "reassigned" && r.status !== "cancelled"; }), bk = (res[1] || []).filter(function (b) { return b && b.vendor_id && b.status !== "cancelled" && !rs.some(function (r) { return r.booking_id === b.id; }); });
      clear(host); host.hidden = !(rs.length || bk.length); if (host.hidden) return false;
      var ul = h("ul", { cls: "hvf-vrows" });
      rs.forEach(function (r) {
        var m = r.status === "accepted" && r.agreed_amount != null && !(r.invoice_only && !num(r.agreed_amount)) ? money(r.agreed_amount, r.currency) : "";
        ul.appendChild(h("li", {}, [h("div", { cls: "hvf-vtop" }, [h("span", {}, [h("b", { text: r.vendor_name }), " · " + r.what]), m ? h("b", { text: m, "data-money": "" }) : null]), api.steps(r)]));
      });
      bk.forEach(function (b) { ul.appendChild(h("li", {}, [h("div", { cls: "hvf-vtop" }, [h("b", { text: b.label || "Vendor" }), b.cost != null ? h("b", { text: money(b.cost), "data-money": "" }) : null]), api.steps(null)])); });
      host.appendChild(h("div", { cls: "rowh" }, [h("h2", { text: "Vendors: prices and invoices" })]));
      host.appendChild(ul);
      // R261 (0450): what vendors charge for missing / broken items - its own lines (the ledger counts them under Damages)
      if (S().vendorCharges) S().vendorCharges.get(quoteId).then(function (st) {
        var l = ((st && st.rows) || []).filter(function (c) { return c.state !== "void"; }); if (!l.length) return;
        var W = { asked: "asked, not agreed yet", agreed: "agreed", in_invoice: "already in their invoice" }, list = h("ul", { cls: "hvf-vrows" }, l.map(function (c) { return h("li", {}, [h("div", { cls: "hvf-vtop" }, [h("span", {}, [h("b", { text: "Vendor damage" }), " · " + c.vendor + " · " + c.label + (c.qty ? " ×" + qn(c.qty) : "") + " · " + (c.state === "agreed" && num(c.paid) >= num(c.amount) - 0.005 ? "paid" : W[c.state] || "")]), h("b", { text: money(c.amount, st.currency), "data-money": "" })])]); }));
        host.insertBefore(h("h3", { cls: "hvf-sub", text: "Charged for missing or broken items" }), link); host.insertBefore(list, link);
      }, function () {});
      var link = h("p", {}, [h("a", { href: "vendors.html?tab=requests&quote=" + encodeURIComponent(quoteId), text: "Open Requests & invoices" })]); host.appendChild(link);
      return true;
    }, function () { host.hidden = true; return false; });
  };
})(typeof window !== "undefined" ? window : globalThis);
